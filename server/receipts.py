"""Printable records of fictional club fees."""

from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

pdfmetrics.registerFont(TTFont("ReceiptInter", str(Path(__file__).with_name("fonts") / "Inter.ttf")))

SAMPLE = {
    "id": "demo-robotics-receipt",
    "programName": "Robotics club",
    "studentId": "s1",
    "period": "2026-10",
    "amountCents": 1250,
    "confirmedOn": "2026-10-15",
}


def visible_receipts(charges, students, profile):
    if profile["role"] not in ("director", "student"):
        return []
    names = {person["id"]: person["name"] for person in students}
    records = [SAMPLE, *(item for item in charges if item["status"] == "confirmed")]
    return [
        {
            "id": item["id"],
            "programName": item["programName"],
            "studentName": names[item["studentId"]],
            "period": item["period"],
            "amountCents": item["amountCents"],
            "confirmedOn": item.get("confirmedOn"),
            "sample": item["id"] == SAMPLE["id"],
        }
        for item in records
        if item["studentId"] in names and (
            profile["role"] == "director" or item["studentId"] == profile["userId"]
        )
    ]


def receipt_pdf(receipt):
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4, leftMargin=54, rightMargin=54, topMargin=56,
        title="School in Action - Demo club receipt", author="School in Action",
    )
    text = ParagraphStyle(
        "receipt", fontName="ReceiptInter", fontSize=12, leading=17,
        textColor=colors.HexColor("#233930"), spaceAfter=10,
        splitLongWords=True,
    )
    title = ParagraphStyle(
        "receipt-title", parent=text,
        fontSize=26, leading=32, spaceAfter=14,
    )
    dollars, cents = divmod(receipt["amountCents"], 100)
    year, month_number = receipt["period"].split("-")
    month = (
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    )[int(month_number) - 1]
    fields = [
        ("Reference", receipt["id"]),
        ("Student", receipt["studentName"]),
        ("Club", receipt["programName"]),
        ("Billing month", f"{month} {year}"),
        ("Confirmed on", receipt["confirmedOn"] or "Date unavailable"),
        ("Fictional amount", f"USD {dollars:,}.{cents:02d}"),
    ]
    contents = [
        Paragraph("School in Action", text),
        Paragraph("Demo club receipt", title),
        Paragraph("Fictional record. No payment collected.", text),
        Spacer(1, 12),
    ]
    contents.extend(Paragraph(f"{label}<br/>{escape(value)}", text) for label, value in fields)
    doc.build(contents)
    return buffer.getvalue()
