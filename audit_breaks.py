#!/usr/bin/env python3
"""Audit: Quinyx-diensten langer dan N uur zonder pauze.

Gebruik:
  QUINYX_API_KEY=... python3 audit_breaks.py --from 2026-10-01 --to 2026-10-10 -o audit.csv
  python3 audit_breaks.py --input response.xml      # offline, op opgeslagen response
  python3 audit_breaks.py ... --dump raw.xml        # sla ruwe response op om veldnamen te checken
"""
import argparse, csv, os, re, sys, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

ENDPOINT = "https://api.quinyx.com/FlexForceWebServices.php"
NS_URI = "uri:FlexForce"
NS_FLEX = "https://api.quinyx.com/soap/FlexForce"

# Veldnamen (lowercase) waarmee we een dienst herkennen; pas aan na --dump indien nodig.
START_KEYS = ("begindatetime", "fromdatetime", "startdatetime", "begin", "start", "fromtime", "timefrom")
END_KEYS = ("enddatetime", "todatetime", "stopdatetime", "end", "stop", "totime", "timeto")
BREAK_MIN_KEYS = ("breakminutes", "breaktime", "breaklength", "breakduration", "unpaidbreak", "paidbreak", "pause")
ID_KEYS = ("id", "scheduleid", "shiftid")
NAME_KEYS = ("employeename", "name", "badgeno", "badgenumber", "employeeid", "employeeno")
UNIT_KEYS = ("unitname", "unit", "unitid", "section", "sectionname")


def build_request(api_key, d_from, d_to):
    return f"""<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:uri="{NS_URI}">
<soapenv:Header/><soapenv:Body>
<uri:wsdlGetSchedulesV3 soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<apiKey xsi:type="xsd:string">{api_key}</apiKey>
<GetSchedulesV3 xsi:type="flex:GetSchedulesV3" xmlns:flex="{NS_FLEX}">
<fromDate xsi:type="xsd:string">{d_from}</fromDate>
<toDate xsi:type="xsd:string">{d_to}</toDate>
</GetSchedulesV3></uri:wsdlGetSchedulesV3></soapenv:Body></soapenv:Envelope>""".encode()


def fetch(api_key, d_from, d_to, endpoint):
    req = urllib.request.Request(endpoint, data=build_request(api_key, d_from, d_to),
                                 headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": ""})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def local(tag):
    return tag.rsplit("}", 1)[-1].lower()


def children(el):
    return {local(c.tag): c for c in el}


def text(el, keys):
    ch = children(el)
    for k in keys:
        if k in ch and (ch[k].text or "").strip():
            return ch[k].text.strip()
    return ""


def parse_dt(s):
    s = s.strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S.%f"):
        try:
            return datetime.strptime(s[:26] if "%f" in fmt else s[:19 if "S" in fmt and "%f" not in fmt else 16], fmt)
        except ValueError:
            continue
    return None


def to_minutes(s):
    """Pauze als minuten. Accepteert '30', '0.5' (uren niet te raden -> minuten), 'HH:MM'."""
    s = (s or "").strip()
    if not s:
        return 0.0
    if ":" in s:
        parts = [float(p) for p in s.split(":")]
        return parts[0] * 60 + parts[1]
    try:
        return float(s)
    except ValueError:
        return 0.0


def break_minutes(shift):
    """Som van pauzes: platte pauzevelden op de dienst + geneste break-elementen met duur of van/tot."""
    total = 0.0
    for c in shift:
        name = local(c.tag)
        if "break" not in name and name not in BREAK_MIN_KEYS:
            continue
        sub = list(c)
        if not sub:
            total += to_minutes(c.text)
            continue
        # genest: ofwel items met start/eind, ofwel een duur
        items = sub if any(list(s) for s in sub) else [c]
        for it in items:
            s, e = parse_dt(text(it, START_KEYS)), parse_dt(text(it, END_KEYS))
            if s and e:
                total += (e - s).total_seconds() / 60
            else:
                total += to_minutes(text(it, BREAK_MIN_KEYS + ("minutes", "duration", "length")))
    return total


def iter_shifts(root):
    for el in root.iter():
        if not len(el) or "break" in local(el.tag):
            continue
        s, e = parse_dt(text(el, START_KEYS)), parse_dt(text(el, END_KEYS))
        if s and e:
            yield el, s, e


def audit(xml_bytes, min_hours):
    root = ET.fromstring(xml_bytes)
    rows, total = [], 0
    for el, s, e in iter_shifts(root):
        total += 1
        if e < s:
            e += timedelta(days=1)
        hours = (e - s).total_seconds() / 3600
        brk = break_minutes(el)
        if hours > min_hours and brk <= 0:
            rows.append({"id": text(el, ID_KEYS), "medewerker": text(el, NAME_KEYS), "unit": text(el, UNIT_KEYS),
                         "start": s.strftime("%Y-%m-%d %H:%M"), "eind": e.strftime("%Y-%m-%d %H:%M"),
                         "uren": round(hours, 2), "pauze_min": 0})
    return rows, total


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="d_from"); ap.add_argument("--to", dest="d_to")
    ap.add_argument("--input", help="gebruik opgeslagen XML-response i.p.v. API-call")
    ap.add_argument("--dump", help="schrijf ruwe response naar dit bestand")
    ap.add_argument("--min-hours", type=float, default=6.0)
    ap.add_argument("--endpoint", default=os.environ.get("QUINYX_ENDPOINT", ENDPOINT))
    ap.add_argument("-o", "--output", default="audit_breaks.csv")
    a = ap.parse_args()

    if a.input:
        xml = open(a.input, "rb").read()
    else:
        key = os.environ.get("QUINYX_API_KEY")
        if not (key and a.d_from and a.d_to):
            ap.error("geef --from/--to en zet QUINYX_API_KEY (of gebruik --input)")
        xml = fetch(key, a.d_from, a.d_to, a.endpoint)
    if a.dump:
        open(a.dump, "wb").write(xml)

    rows, total = audit(xml, a.min_hours)
    rows.sort(key=lambda r: (r["start"], r["medewerker"]))
    fields = ["id", "medewerker", "unit", "start", "eind", "uren", "pauze_min"]
    with open(a.output, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fields, delimiter=";"); w.writeheader(); w.writerows(rows)
    print(f"{total} diensten gecontroleerd, {len(rows)} > {a.min_hours:g}u zonder pauze -> {a.output}")
    if total == 0:
        print("Geen diensten herkend: check de response met --dump en pas de *_KEYS aan.", file=sys.stderr)


if __name__ == "__main__":
    main()
