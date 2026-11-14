"""Shared PDF typeface for the school workspace."""
from pathlib import Path
from threading import Lock

from fastapi import HTTPException
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.ttfonts import TTFError

_registration = Lock()


def school_pdf_font():
    name = 'SchoolInter'
    with _registration:
        if name not in pdfmetrics.getRegisteredFontNames():
            try:
                pdfmetrics.registerFont(TTFont(name, str(Path(__file__).parent / 'assets' / 'Inter.ttf')))
            except (OSError, TTFError):
                raise HTTPException(503, 'The PDF font is unavailable.') from None
    return name
