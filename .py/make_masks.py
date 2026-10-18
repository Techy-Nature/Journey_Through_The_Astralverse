"""Build solid white hair / skin / iris masks for Astralscape portrait bases.

Method: confident colour seeds (skin, hair, iris, other) are grown across
the shading with a watershed on the colour-edge map, so each region stops at
the line art. The regions are then flattened (strand lines, pupils, nose and
mouth lines filled in) and saved as white on transparent.

Usage: python3 make_masks.py SRC_DIR OUT_DIR [PREVIEW_DIR]
"""
import sys, os, glob
import cv2
import numpy as np
from scipy import ndimage as ndi
from skimage.segmentation import watershed

BG, SKIN, HAIR, IRIS, OTHER = 1, 2, 3, 4, 5


def disk(r):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def close(m, r):
    return cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, disk(r)).astype(bool)


def open_(m, r):
    return cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, disk(r)).astype(bool)


def dilate(m, r):
    return cv2.dilate(m.astype(np.uint8), disk(r)).astype(bool)


def fill_holes(m):
    return ndi.binary_fill_holes(m)


def fill_small_holes(m, max_px):
    holes = fill_holes(m) & ~m
    return m | (holes & ~keep_big(holes, max_px + 1))


def components(m):
    n, lab, stats, cent = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
    return n, lab, stats, cent


def keep_big(m, min_px):
    n, lab, stats, _ = components(m)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_px
    return keep[lab]


def build(path):
    im = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    bgr = im[:, :, :3]
    alpha = im[:, :, 3]
    h, w = alpha.shape
    s = max(h, w) / 1254.0
    R = lambda r: max(1, int(round(r * s)))
    A = lambda px: max(4, int(px * s * s))

    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(int)
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    opaque = alpha > 40
    warm = (H <= 24) | (H >= 168)

    # ---------------- confident seeds ----------------
    gold_core = open_(opaque & (H >= 17) & (H <= 35) & (S >= 140) & (V >= 150), 1)
    gold = dilate(gold_core, R(5)) & opaque & (H <= 35) & ~((V >= 175) & (S <= 150))
    skin_seed = opaque & warm & (V >= 190) & (S >= 80) & (S <= 150) & ~gold
    hair_seed = opaque & warm & (V >= 4) & (
        ((S >= 110) & (V <= 125)) | ((S >= 60) & (V < 70)))
    iris_seed = opaque & (H >= 95) & (H <= 135) & (S >= 110) & (V >= 4)
    other_seed = opaque & (
        open_((S < 45) & (V >= 40) & opaque, R(3))   # clothes, sclera (not specks)
        | gold
        | open_(opaque & (V < 30) & ~(warm & (S >= 60)), R(6))  # big black areas, not lines
        | (~warm & ~((H >= 95) & (H <= 135)) & (S >= 45) & (V >= 40))  # other colours
    )

    # iris seeds only count near the face (shirts can be faintly blue)
    skin_core = keep_big(open_(skin_seed, R(2)), A(3000))
    face_zone = np.zeros((h, w), np.uint8)
    n, lab_s, st, _ = components(skin_core)
    for i in range(1, n):
        pts = cv2.findNonZero((lab_s == i).astype(np.uint8))
        cv2.fillConvexPoly(face_zone, cv2.convexHull(pts), 1)
    face_zone = dilate(face_zone.astype(bool), R(30))
    iris_seed &= face_zone
    iris_seed = keep_big(iris_seed, A(40))
    n, lab_b, st, cen = components(iris_seed)
    ok = np.zeros(n, bool)
    ok[1:] = cen[1:, 1] < 0.5 * h           # eyes sit in the upper half
    iris_seed = ok[lab_b]

    # line art is dark brown too: only wide brown areas seed hair, and the
    # lash / lid line around each eye is never hair
    hair_seed = open_(hair_seed, R(5))
    # wide, short zone around each eye: lashes and eyeliner wings, not brows
    eye_zone = cv2.dilate(iris_seed.astype(np.uint8), cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (2 * R(70) + 1, 2 * R(16) + 1))).astype(bool)
    lid = hair_seed & eye_zone
    hair_seed &= ~eye_zone
    other_seed |= lid
    # lashes / lid line stay "other"; elsewhere black line art is left
    # unseeded so it splits between its neighbours
    other_seed |= opaque & eye_zone & (V < 30) & (S < 70) & ~iris_seed

    markers = np.zeros((h, w), np.int32)
    markers[~opaque] = BG
    markers[other_seed] = OTHER
    markers[open_(skin_seed, R(1))] = SKIN
    markers[hair_seed] = HAIR
    markers[iris_seed] = IRIS

    # colour edge strength (Lab gradient) for the watershed
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    lab = cv2.GaussianBlur(lab, (0, 0), 0.8)
    g = np.zeros((h, w), np.float32)
    for c in range(3):
        gx = cv2.Sobel(lab[..., c], cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(lab[..., c], cv2.CV_32F, 0, 1, ksize=3)
        g += gx * gx + gy * gy
    g = np.sqrt(g)

    labels = watershed(g, markers)

    skin = labels == SKIN
    hair = labels == HAIR
    iris = labels == IRIS

    # ---------------- hair: absorb dark undercut / shadowed hair -----------
    n, lab_i, st, cen = components(keep_big(iris, A(40)))
    if n > 1:
        eye_y = float(np.mean(cen[1:, 1]))
    else:                                   # fallback: upper third of face
        ys = np.nonzero(skin_core)[0]
        eye_y = float(ys.min() + 0.3 * (np.percentile(ys, 50) - ys.min())) if len(ys) else h * 0.3
    dark = opaque & (V < 60) & ((labels == OTHER) | (labels == BG)) & ~dilate(iris_seed, R(16))
    dark_wide = open_(dark, R(5))
    n, lab_d, st, cen = components(dark_wide)
    hair0 = hair.copy()                     # judge against the original hair only
    hair_near = dilate(hair0, R(3))
    near_eye = dilate(iris_seed, R(55))
    band_bottom = eye_y + 0.10 * h
    for i in range(1, n):
        comp = lab_d == i
        if not (comp & hair_near).any():
            continue
        if (comp & near_eye).sum() > 0.5 * comp.sum():
            continue                        # glasses frames, lash shadow
        bottom = st[i, cv2.CC_STAT_TOP] + st[i, cv2.CC_STAT_HEIGHT]
        ring = dilate(comp, R(3)) & ~comp
        hair_frac = (ring & hair0).sum() / max(1, ring.sum())
        in_head = bottom <= band_bottom
        small = st[i, cv2.CC_STAT_AREA] <= A(25000)
        if not ((small and hair_frac >= 0.45) or (in_head and hair_frac >= 0.15)):
            continue                        # clothing / glasses, not hair
        hair |= dilate(comp, R(1)) & dark

    # grow hair into brown pixels the neighbouring dark seeds stole
    brown = opaque & warm & (S >= 60) & (V < 90) & (labels != SKIN) & ~eye_zone
    for _ in range(8):
        hair |= dilate(hair, R(2)) & brown

    hair = keep_big(hair, A(300))
    hair = close(hair, R(4))
    hair = fill_small_holes(hair, A(2500)) & opaque
    # anything hair-labelled that sits on the eye is lid shading, not hair
    hair &= ~cv2.dilate(iris.astype(np.uint8), cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (2 * R(30) + 1, 2 * R(12) + 1))).astype(bool)

    # keep the hair mass plus eyebrows; drop stray dark-skin shadows
    n, lab_h, st, cen = components(hair)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        area = st[i, cv2.CC_STAT_AREA]
        cy, cx = cen[i, 1], cen[i, 0]
        if area >= A(6000):
            keep[i] = True
        elif area >= A(250) and eye_y - 0.15 * h <= cy <= eye_y and face_zone[int(cy), int(cx)]:
            keep[i] = True                  # eyebrow
    hair = keep[lab_h] & ~gold

    # ---------------- iris: fill pupil and highlights ----------------------
    iris = keep_big(iris, A(40))
    iris = fill_holes(close(iris, R(3))) & opaque
    # keep the two real eyes: the two largest blobs of similar size
    n, lab_e, st, _ = components(iris)
    if n > 1:
        areas = st[1:, cv2.CC_STAT_AREA]
        order = np.argsort(areas)[::-1][:2]
        keep = np.zeros(n, bool)
        for j in order:
            if areas[j] >= 0.3 * areas.max():
                keep[j + 1] = True
        iris = keep[lab_e]

    # ---------------- skin: flatten inner lines, drop eyes/hair ------------
    skin = keep_big(skin, A(400))
    skin = fill_small_holes(close(skin, R(7)), A(6000))
    sclera = opaque & (S < 45) & (V > 190) & face_zone
    eye_area = dilate(iris, R(1)) | dilate(keep_big(sclera, A(30)), R(1))
    skin &= ~(hair | eye_area | gold)
    skin = keep_big(skin, A(400)) & opaque

    return im, {"hair": hair, "skin": skin, "eyes": iris}


def save_mask(m, alpha, path):
    h, w = m.shape
    out = np.zeros((h, w, 4), np.uint8)
    out[..., :3] = 255
    out[..., 3] = np.where(m, alpha, 0).astype(np.uint8)
    cv2.imwrite(path, out)


def preview(im, masks, path):
    bgr = im[:, :, :3].astype(float)
    a = im[:, :, 3:4] / 255.0
    base = bgr * a + 30.0 * (1 - a)
    cols = {"hair": (255, 0, 255), "skin": (0, 220, 0), "eyes": (255, 255, 0)}
    over = base.copy()
    for k, m in masks.items():
        over[m] = over[m] * 0.3 + np.array(cols[k]) * 0.7
    cv2.imwrite(path, np.hstack([base, over]).astype(np.uint8))


if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    prev = sys.argv[3] if len(sys.argv) > 3 else None
    os.makedirs(out, exist_ok=True)
    if prev:
        os.makedirs(prev, exist_ok=True)
    for f in sorted(glob.glob(os.path.join(src, "*_base.png"))):
        stem = os.path.basename(f)[: -len("_base.png")]
        im, masks = build(f)
        for part, m in masks.items():
            save_mask(m, im[:, :, 3], os.path.join(out, f"{stem}_{part}_mask.png"))
        if prev:
            preview(im, masks, os.path.join(prev, f"{stem}.png"))
        print(stem, {k: int(v.sum()) for k, v in masks.items()})
