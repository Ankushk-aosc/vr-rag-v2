import logging
from pathlib import Path
from typing import Optional, Union

import numpy as np
from PIL import Image

from app.config import settings

logger = logging.getLogger(__name__)


def deskew_image(cv_image: np.ndarray) -> np.ndarray:
    """Deskew image by finding the minimum area bounding box of non-background text pixels."""
    try:
        import cv2

        # Invert colors so text is foreground (white)
        blur = cv2.GaussianBlur(cv_image, (9, 9), 0)
        thresh = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]

        # Find coordinates of all foreground pixels
        coords = np.column_stack(np.where(thresh > 0))
        if len(coords) < 50:
            return cv_image

        angle = cv2.minAreaRect(coords)[-1]
        if angle < -45:
            angle = -(90 + angle)
        elif angle > 45:
            angle = 90 - angle
        else:
            angle = -angle

        # Only correct noticeable skew
        if abs(angle) > 0.5 and abs(angle) < 45:
            (h, w) = cv_image.shape[:2]
            center = (w // 2, h // 2)
            M = cv2.getRotationMatrix2D(center, angle, 1.0)
            rotated = cv2.warpAffine(
                cv_image, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
            )
            return rotated
    except Exception as e:
        logger.debug("Deskew failed or skipped: %s", e)
    return cv_image


def preprocess_image(
    image: Union[Image.Image, np.ndarray, Path, str]
) -> Image.Image:
    """
    Config-toggled image preprocessing:
    1. Grayscale
    2. Deskew
    3. Binarise (Otsu)
    4. Operates strictly on a temporary copy / in-memory buffer.
    """
    if isinstance(image, (str, Path)):
        pil_img = Image.open(str(image)).copy()
    elif isinstance(image, np.ndarray):
        pil_img = Image.fromarray(image).copy()
    else:
        pil_img = image.copy()

    if not settings.OCR_PREPROCESS_ENABLED:
        return pil_img

    try:
        import cv2

        # 1. Grayscale
        rgb = np.array(pil_img.convert("RGB"))
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

        # 2. Deskew
        deskewed = deskew_image(gray)

        # 3. Binarise with Otsu's thresholding
        binarised = cv2.threshold(deskewed, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]

        return Image.fromarray(binarised)
    except Exception as e:
        logger.warning("OpenCV image preprocessing encountered error, falling back to PIL: %s", e)
        # Fallback to pure PIL grayscale and contrast
        gray_pil = pil_img.convert("L")
        return gray_pil

