#!/usr/bin/env python3
"""Audit: Quinyx-diensten langer dan N uur zonder pauze.

Gebruik:
  QUINYX_API_KEY=... python3 audit_breaks.py --from 2026-10-01 --to 2026-10-10 -o audit.csv
  python3 audit_breaks.py --input response.xml      # offline, op opgeslagen response
  python3 audit_breaks.py ... --dump raw.xml        # sla ruwe response op om veldnamen te checken
"""
import argparse, csv, os, sys, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

ENDPOINT = "https://api.quinyx.com/FlexForceWebServices.php"
NS_URI = "uri:FlexForce"
NS_FLEX = "https://api.quinyx.com/soap/FlexForce"

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
    return tag.rsplit("}", 1)[-1]


def fields(item):
    return {local(c.tag): (c.text or "").strip() for c in item}


def dt(date, time):
    return datetime.strptime(f"{date} {time}", "%Y-%m-%d %H:%M:%S")


def break_minutes(f):
    """Som van pauzes 1-4; 00:00:00-00:00:00 betekent 'geen pauze'."""
    total = 0.0
    for suffix in ("", "2", "3", "4"):
        b, e = f.get(f"begBreak{suffix}", "00:00:00"), f.get(f"endBreak{suffix}", "00:00:00")
        s_, e_ = dt("2000-01-01", b), dt("2000-01-01", e)
        if e_ < s_:
            e_ += timedelta(days=1)
        total += (e_ - s_).total_seconds() / 60
    return total


def audit(xml_bytes, min_hours):
    root = ET.fromstring(xml_bytes)
    rows, total, skipped = [], 0, 0
    for item in root.iter():
        if local(item.tag) != "item":
            continue
        f = fields(item)
        if "begDate" not in f or "begTime" not in f:
            continue
        total += 1
        # verlof / vrije dagen zijn geen werkdiensten
        if f.get("isFreeDay") == "true" or f.get("approvedLeave") == "true" \
                or f.get("leaveReasonId", "0") != "0" or f.get("productiveTime") == "false":
            skipped += 1
            continue
        s_, e_ = dt(f["begDate"], f["begTime"]), dt(f["endDate"], f["endTime"])
        hours = (e_ - s_).total_seconds() / 3600
        brk = break_minutes(f)
        if hours > min_hours and brk <= 0:
            rows.append({"scheduleId": f.get("scheduleId"), "persId": f.get("persId"), "badgeNo": f.get("badgeNo"),
                         "unit": f.get("unitName"), "section": f.get("sectionName"), "categorie": f.get("categoryName"),
                         "start": s_.strftime("%Y-%m-%d %H:%M"), "eind": e_.strftime("%Y-%m-%d %H:%M"),
                         "uren_bruto": round(hours, 2), "uren_veld": f.get("hours"), "breakType": f.get("breakType"),
                         "comment": f.get("comment")})
    return rows, total, skipped


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

    rows, total, skipped = audit(xml, a.min_hours)
    rows.sort(key=lambda r: (r["start"], r["badgeNo"]))
    cols = list(rows[0]) if rows else ["scheduleId", "persId", "badgeNo", "unit", "section", "categorie", "start", "eind", "uren_bruto", "uren_veld", "breakType", "comment"]
    with open(a.output, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, cols, delimiter=";"); w.writeheader(); w.writerows(rows)
    print(f"{total} diensten gecontroleerd ({skipped} verlof/vrij overgeslagen), {len(rows)} > {a.min_hours:g}u zonder pauze -> {a.output}")
    if total == 0:
        print("Geen diensten herkend: check de response met --dump.", file=sys.stderr)


if __name__ == "__main__":
    main()
