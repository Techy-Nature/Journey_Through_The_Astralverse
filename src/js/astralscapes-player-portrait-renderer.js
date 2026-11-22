/*
 * Astralscapes dynamic player portrait renderer (Duplex 1.10.0 edition, v3)
 *
 * Put this whole file in a passage tagged "script" (Story JavaScript),
 * or keep it as a .js file in your story folder.
 *
 * Expected default filenames:
 *   img/player/bases/[gender]_[muscularity]_base.png
 *   img/player/masks/[gender]_[muscularity]_skin_mask.png
 *   img/player/masks/[gender]_[muscularity]_hair-eyebrows_mask.png
 *   img/player/masks/[gender]_[muscularity]_eyes_mask.png
 *
 * Pictures that NesTwee or Tweego embedded into the story (Twine.image
 * passages) are used first, so the portrait still works when story.html is
 * opened from a file manager. If a picture is not embedded, the path above is
 * loaded instead.
 *
 * In a passage, write:
 *   <div data-portrait-builder></div>   a live preview plus a color picker for every trait
 *   <div data-portrait-preview></div>   only the live portrait
 * <<speech player>> bubbles show the portrait automatically.
 *
 * Story variables (all colors are saved as #rrggbb hex codes):
 *   $p.skin.color  $p.hair.color  $p.eyes.color   the chosen color
 *   $p.hair.tint   $p.eyes.tint                   0-100, how strongly it is painted
 *   $p.[trait].preset                             swatch name, or "" for a custom color
 *
 * The page also gets CSS variables you can use anywhere:
 *   --player-eyes-color, --player-hair-color, --player-skin-color
 *   --player-eyes-text (black or white, whichever reads better on that color)
 */
(function () {
    "use strict";

    /* Preset swatches for each trait. Any #rrggbb color also works. */
    const palettes = {
        skin: {
            pale: "#f0ad80",
            olive: "#c58d63",
            brown: "#986344",
            dark: "#65402f"
        },
        hair: {
            black: "#171412",
            blonde: "#d7b56f",
            "light-brown": "#a47552",
            "strawberry-blonde": "#c9825c",
            brown: "#704831",
            "dark-brown": "#452f26",
            auburn: "#793d2e"
        },
        eyes: {
            "dark-brown": "#3b2a21",
            brown: "#654332",
            hazel: "#817046",
            amber: "#b77a32",
            green: "#56875a",
            blue: "#4f80a6",
            grey: "#858b91"
        }
    };

    const config = {
        baseDirectory: "img/player/bases",
        maskDirectory: "img/player/masks",

        /*
         * Every changeable trait, in the order it is painted and shown in the
         * builder. Each one is stored in $p.[trait] and painted through the
         * mask file "[gender]_[muscularity]_[mask].png".
         *
         *   label     heading in the builder
         *   mask      end of the mask file name
         *   mode      "hsv"   = hue + saturation from the chosen color, brightness
         *                       moved to the chosen brightness while keeping the
         *                       art's shading, then blended by the tint amount
         *             "shade" = the original lightness-matching recolor
         *   controls  "hsv"   = swatches, color square, hex, plus Hue, Saturation,
         *                       Value and Tint sliders
         *             "basic" = swatches, color square and hex only
         *   original  (optional) the color the art is drawn in, as #rrggbb.
         *             Leave it out to measure it from the picture.
         *
         * To add a trait (for example lips), add a palette above, a default
         * color below, an entry here, and the mask picture:
         *   lips: { label: "Lips", mask: "lips_mask", mode: "hsv", controls: "hsv" }
         */
        traits: {
            skin: { label: "Skin", mask: "skin_mask", mode: "shade", controls: "basic" },
            hair: { label: "Hair & eyebrows", mask: "hair-eyebrows_mask", mode: "hsv", controls: "hsv" },
            eyes: { label: "Eyes", mask: "eyes_mask", mode: "hsv", controls: "hsv", original: "#3b2a21" }
        },

        /* Used whenever a saved/custom value is empty or invalid. */
        defaultColors: {
            skin: "pale",
            hair: "dark-brown",
            eyes: "dark-brown"
        },

        /* Starting tint strength (0-100) for "hsv" traits. */
        defaultTint: 100,

        /*
         * Override a filename only when an asset does not follow the standard
         * naming pattern. The key is "[gender]_[muscularity]".
         *
         * Example:
         * "transgender-woman_muscular": {
         *     base: "transwoman_muscular_base.png",
         *     hair: "transgender-woman_muscular_hair-eyebrows-mask.png"
         * }
         */
        fileOverrides: {},

        /* Used when $p.gender is empty (for example before the player picks one). */
        defaultGender: "woman",

        /* Milliseconds to wait after the last color change before redrawing. */
        renderDelay: 60,

        selectors: {
            /* Duplex's <<speech player>> portrait. */
            avatar: ".duplex-speech-player",
            builder: "[data-portrait-builder]",
            preview: "[data-portrait-preview]"
        }
    };

    const imageCache = new Map();
    const maskCache = new Map();
    let renderSequence = 0;
    let currentDataUrl = "";
    let lastSignature = "";
    let syncTimer = 0;

    /* ---------- small helpers ---------- */

    function clean(value) {
        return String(value == null ? "" : value)
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "-");
    }

    function clamp(value, low, high) {
        return Math.max(low, Math.min(high, value));
    }

    function traitNames() {
        return Object.keys(config.traits);
    }

    function traitSetting(trait, key, fallback) {
        const settings = config.traits[trait] || {};
        return settings[key] == null ? fallback : settings[key];
    }

    function hexToRgb(hex) {
        const normalized = hex.replace("#", "");
        const value = Number.parseInt(
            normalized.length === 3
                ? normalized.split("").map(char => char + char).join("")
                : normalized,
            16
        );
        return {
            r: (value >> 16) & 255,
            g: (value >> 8) & 255,
            b: value & 255
        };
    }

    function rgbToHex(r, g, b) {
        return "#" + [r, g, b]
            .map(channel => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0"))
            .join("");
    }

    function normalizeHex(value) {
        if (typeof value === "number" && Number.isInteger(value)
                && value >= 0 && value <= 0xFFFFFF) {
            return `#${value.toString(16).padStart(6, "0")}`;
        }

        const text = String(value == null ? "" : value).trim();
        const match = text.match(/^(?:#|0x)?([0-9a-f]{6}|[0-9a-f]{3})$/i);
        if (!match) return null;
        const digits = match[1].length === 3
            ? match[1].split("").map(character => character + character).join("")
            : match[1];
        return `#${digits.toLowerCase()}`;
    }

    /* HSL, used by the "shade" mode. */
    function rgbToHsl(r, g, b) {
        r /= 255;
        g /= 255;
        b /= 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const lightness = (max + min) / 2;
        const difference = max - min;
        let hue = 0;
        let saturation = 0;

        if (difference !== 0) {
            saturation = lightness > 0.5
                ? difference / (2 - max - min)
                : difference / (max + min);
            switch (max) {
                case r:
                    hue = ((g - b) / difference + (g < b ? 6 : 0)) / 6;
                    break;
                case g:
                    hue = ((b - r) / difference + 2) / 6;
                    break;
                default:
                    hue = ((r - g) / difference + 4) / 6;
            }
        }
        return { h: hue, s: saturation, l: lightness };
    }

    function hueToRgb(p, q, t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    }

    function hslToRgb(h, s, l) {
        if (s === 0) {
            const grey = Math.round(l * 255);
            return { r: grey, g: grey, b: grey };
        }
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        return {
            r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
            g: Math.round(hueToRgb(p, q, h) * 255),
            b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255)
        };
    }

    /* HSV (hue 0-1, saturation 0-1, value 0-1), used by the "hsv" mode and sliders. */
    function rgbToHsv(r, g, b) {
        r /= 255;
        g /= 255;
        b /= 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const difference = max - min;
        let hue = 0;
        if (difference !== 0) {
            switch (max) {
                case r:
                    hue = ((g - b) / difference + (g < b ? 6 : 0)) / 6;
                    break;
                case g:
                    hue = ((b - r) / difference + 2) / 6;
                    break;
                default:
                    hue = ((r - g) / difference + 4) / 6;
            }
        }
        return { h: hue, s: max === 0 ? 0 : difference / max, v: max };
    }

    function hsvToRgb(h, s, v) {
        const sector = Math.floor(h * 6);
        const fraction = h * 6 - sector;
        const p = v * (1 - s);
        const q = v * (1 - fraction * s);
        const t = v * (1 - (1 - fraction) * s);
        let r;
        let g;
        let b;
        switch (((sector % 6) + 6) % 6) {
            case 0: r = v; g = t; b = p; break;
            case 1: r = q; g = v; b = p; break;
            case 2: r = p; g = v; b = t; break;
            case 3: r = p; g = q; b = v; break;
            case 4: r = t; g = p; b = v; break;
            default: r = v; g = p; b = q;
        }
        return { r: r * 255, g: g * 255, b: b * 255 };
    }

    function hexToHsv(hex) {
        const rgb = hexToRgb(hex);
        return rgbToHsv(rgb.r, rgb.g, rgb.b);
    }

    function hsvToHex(h, s, v) {
        const rgb = hsvToRgb(h, s, v);
        return rgbToHex(rgb.r, rgb.g, rgb.b);
    }

    /* Black or white, whichever is easier to read on this color. */
    function readableText(hex) {
        const { r, g, b } = hexToRgb(hex);
        const channel = value => {
            const c = value / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        return luminance > 0.36 ? "#121417" : "#f6f7f9";
    }

    function displayName(value) {
        return String(value)
            .split("-")
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
    }

    /* ---------- color names ---------- */

    /* Hue (degrees) where each name starts. */
    const hueNames = [
        [0, "red"], [12, "red-orange"], [22, "orange"], [30, "amber"], [48, "yellow"],
        [66, "yellow-green"], [85, "green"], [140, "sea green"], [165, "teal"],
        [185, "cyan"], [198, "sky blue"], [215, "blue"], [242, "indigo"],
        [262, "violet"], [282, "purple"], [305, "magenta"], [330, "rose"], [348, "red"]
    ];

    function titleCase(text) {
        return text.replace(/(^|[\s-])([a-z])/g, (match, gap, letter) => gap + letter.toUpperCase());
    }

    /*
     * A plain-English name for any color, worked out from its hue,
     * saturation and lightness, e.g. "#4dd089" -> "Sea Green",
     * "#3b2a21" -> "Very Dark Brown", "#d7b56f" -> "Muted Amber".
     */
    function colorName(hexColor) {
        const hex = normalizeHex(hexColor);
        if (!hex) return "Unknown";
        const { r, g, b } = hexToRgb(hex);
        const { h, s, l } = rgbToHsl(r, g, b);
        const hue = h * 360;

        /* Greys, black and white */
        if (s < 0.1 || l < 0.1 || l > 0.96) {
            if (l < 0.1) return "Black";
            if (l < 0.25) return "Charcoal";
            if (l < 0.45) return "Dark Grey";
            if (l < 0.65) return "Grey";
            if (l < 0.88) return "Light Grey";
            return "White";
        }

        let base = null;
        let usesLightness = true;

        /* Earthy colors: browns, olives, skin tones, pinks */
        if (hue >= 8 && hue < 50 && (l < 0.38 || (l < 0.5 && s < 0.5))) {
            if (hue < 15 && l >= 0.25 && s >= 0.35) {
                base = "auburn";
                usesLightness = false;
            } else {
                base = hue < 15 ? "reddish brown" : hue < 34 ? "brown" : "golden brown";
            }
        } else if (hue >= 50 && hue < 75 && l < 0.4) {
            base = "olive";
        } else if (hue >= 10 && hue < 32 && l >= 0.5 && l < 0.85 && s < 0.85) {
            base = l < 0.62 ? "tan" : "peach";
            usesLightness = false;
        } else if (hue >= 32 && hue < 55 && l >= 0.5 && l < 0.85 && s < 0.85) {
            base = s < 0.4 ? "sand" : "gold";
        } else if ((hue >= 330 || hue < 12) && l >= 0.68) {
            base = "pink";
        } else if (hue >= 262 && hue < 305 && l >= 0.7) {
            base = "lavender";
            usesLightness = false;
        }

        if (!base) {
            base = hueNames.reduce((found, [start, label]) => (hue >= start ? label : found), "red");
        }

        const words = [];
        if (usesLightness) {
            if (l < 0.18) words.push("very dark");
            else if (l < 0.32) words.push("dark");
            else if (l > 0.85) words.push("pale");
            else if (l > 0.7) words.push("light");
        }
        const earthy = /brown|olive|auburn|tan|peach|sand/.test(base);
        if (s < 0.18 && l > 0.12) words.push("greyish");
        else if (s < 0.5 && l >= 0.32 && !earthy) words.push("muted");
        else if (s > 0.8 && l >= 0.35 && l <= 0.65) words.push("vivid");

        return titleCase([...words, base].join(" "));
    }

    /* The same hue, made light enough to read as text on the dark panels. */
    function readableOnDark(hexColor) {
        const { r, g, b } = hexToRgb(hexColor);
        const { h, s, l } = rgbToHsl(r, g, b);
        const rgb = hslToRgb(h, Math.min(s, 0.9), Math.max(l, 0.68));
        return rgbToHex(rgb.r, rgb.g, rgb.b);
    }

    /* ---------- pictures ---------- */

    /*
     * NesTwee and Tweego turn pictures next to the .twee files into passages
     * tagged Twine.image that hold the picture as a data: URI. Using those
     * avoids broken relative paths (content:// links on Android) and keeps
     * the canvas readable on file:// pages.
     */
    function embeddedImage(path) {
        const raw = String(path == null ? "" : path).trim();
        if (!raw || /^(?:data|blob|https?|content|file):/i.test(raw)) return null;
        const storyData = document.querySelector("tw-storydata");
        if (!storyData) return null;

        let decoded = raw;
        try { decoded = decodeURIComponent(raw); } catch (error) { /* keep raw */ }
        const trimmed = decoded.replace(/[?#].*$/, "").replace(/^\.\//, "");
        const base = trimmed.split("/").pop();
        const names = [raw, trimmed, base,
            trimmed.replace(/\.[^./]+$/, ""), base.replace(/\.[^./]+$/, ""), base.split(".")[0]];

        const media = [...storyData.querySelectorAll("tw-passagedata")]
            .filter(node => (node.getAttribute("tags") || "").split(/\s+/).includes("Twine.image"));
        for (const name of names) {
            const found = media.find(node => node.getAttribute("name") === name);
            if (found) return found.textContent.trim();
        }
        return null;
    }

    function resolveImage(path) {
        return embeddedImage(path) || path;
    }

    function loadImage(path) {
        if (!imageCache.has(path)) {
            imageCache.set(path, new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => {
                    imageCache.delete(path);
                    reject(new Error(`Could not load portrait picture: ${path}`));
                };
                image.src = resolveImage(path);
            }));
        }
        return imageCache.get(path);
    }

    function join(directory, filename) {
        return `${directory.replace(/\/$/, "")}/${filename}`;
    }

    function assetPaths(appearance) {
        const gender = clean(appearance.gender);
        const muscularity = clean(appearance.muscularity);
        const key = `${gender}_${muscularity}`;
        const override = config.fileOverrides[key] || {};
        const masks = {};
        traitNames().forEach(trait => {
            masks[trait] = join(config.maskDirectory,
                override[trait] || `${key}_${config.traits[trait].mask}.png`);
        });

        return {
            key,
            base: join(config.baseDirectory, override.base || `${key}_base.png`),
            masks
        };
    }

    function readPixels(image, width, height) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0, width, height);
        try {
            return context.getImageData(0, 0, width, height);
        } catch (error) {
            throw new Error("The browser blocked reading the portrait pictures. "
                + "Keep the img folder inside your story folder so NesTwee embeds them, "
                + "or open the story from a web address instead of a file.");
        }
    }

    /*
     * How strongly each pixel belongs to a trait, from 0 to 1.
     *
     * - A mask with transparency: the opaque parts are the trait.
     * - A mask with no transparency at all (a plain black-and-white picture):
     *   the white parts are the trait, or the black parts if the picture is
     *   mostly white.
     *
     * The strongest pixel always counts as fully painted, so a mask drawn
     * with a soft or half-transparent brush still recolors at full strength.
     */
    function maskWeights(path, image, width, height) {
        const cacheKey = `${path}@${width}x${height}`;
        if (maskCache.has(cacheKey)) return maskCache.get(cacheKey);

        const data = readPixels(image, width, height).data;
        const count = width * height;
        const weights = new Float32Array(count);
        let opaque = true;
        for (let pixel = 0; pixel < count; pixel += 1) {
            if (data[pixel * 4 + 3] < 250) { opaque = false; break; }
        }

        let total = 0;
        if (opaque) {
            for (let pixel = 0; pixel < count; pixel += 1) {
                const index = pixel * 4;
                weights[pixel] = (data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114) / 255;
                total += weights[pixel];
            }
            if (total / count > 0.5) {
                for (let pixel = 0; pixel < count; pixel += 1) weights[pixel] = 1 - weights[pixel];
            }
        } else {
            for (let pixel = 0; pixel < count; pixel += 1) {
                weights[pixel] = data[pixel * 4 + 3] / 255;
            }
        }

        let strongest = 0;
        for (let pixel = 0; pixel < count; pixel += 1) {
            if (weights[pixel] > strongest) strongest = weights[pixel];
        }
        if (strongest > 0 && strongest < 1) {
            for (let pixel = 0; pixel < count; pixel += 1) {
                weights[pixel] = Math.min(1, weights[pixel] / strongest);
            }
        }

        const result = { weights, empty: strongest === 0 };
        maskCache.set(cacheKey, result);
        return result;
    }

    /* The original lightness-matching recolor (skin). */
    function recolorShade(imageData, weights, hexColor) {
        const targetRgb = hexToRgb(hexColor);
        const targetHsl = rgbToHsl(targetRgb.r, targetRgb.g, targetRgb.b);
        const pixels = imageData.data;
        let weightedLightness = 0;
        let totalWeight = 0;

        for (let pixel = 0; pixel < weights.length; pixel += 1) {
            const weight = weights[pixel];
            if (weight <= 0) continue;
            const index = pixel * 4;
            const source = rgbToHsl(pixels[index], pixels[index + 1], pixels[index + 2]);
            weightedLightness += source.l * weight;
            totalWeight += weight;
        }

        const averageLightness = totalWeight ? weightedLightness / totalWeight : 0.5;

        for (let pixel = 0; pixel < weights.length; pixel += 1) {
            const weight = weights[pixel];
            if (weight <= 0) continue;
            const index = pixel * 4;
            const source = rgbToHsl(pixels[index], pixels[index + 1], pixels[index + 2]);
            const lightness = clamp(targetHsl.l + (source.l - averageLightness) * 0.92, 0.015, 0.985);
            const colored = hslToRgb(targetHsl.h, targetHsl.s, lightness);
            pixels[index] = Math.round(pixels[index] * (1 - weight) + colored.r * weight);
            pixels[index + 1] = Math.round(pixels[index + 1] * (1 - weight) + colored.g * weight);
            pixels[index + 2] = Math.round(pixels[index + 2] * (1 - weight) + colored.b * weight);
        }
    }

    /*
     * Tint + HSV recolor (hair, eyes).
     *
     * 1. Work out the art's own color under the mask (or use `original`),
     *    for example dark brown for the eyes.
     * 2. Every masked pixel takes the chosen hue.
     * 3. Saturation and value move to the chosen color's saturation and value,
     *    keeping each pixel's distance from the art's own color, so shadows,
     *    highlights and line detail survive. Dark art is stretched when a
     *    brighter color is chosen, so a light color really shows up light.
     * 4. Bright, nearly white catchlights in the eyes are mostly left alone.
     * 5. The result is blended over the art by the tint amount (0-100).
     */
    function recolorHsv(imageData, weights, hexColor, tintPercent, originalHex) {
        const target = hexToHsv(hexColor);
        const tint = clamp(Number(tintPercent), 0, 100) / 100;
        if (!(tint > 0)) return;
        const pixels = imageData.data;

        let reference;
        const original = normalizeHex(originalHex);
        if (original) {
            reference = hexToHsv(original);
        } else {
            let sumS = 0;
            let sumV = 0;
            let total = 0;
            for (let pixel = 0; pixel < weights.length; pixel += 1) {
                const weight = weights[pixel];
                if (weight <= 0) continue;
                const index = pixel * 4;
                const source = rgbToHsv(pixels[index], pixels[index + 1], pixels[index + 2]);
                sumS += source.s * weight;
                sumV += source.v * weight;
                total += weight;
            }
            reference = total
                ? { h: 0, s: sumS / total, v: sumV / total }
                : { h: 0, s: 0.5, v: 0.5 };
        }

        const valueGain = clamp(target.v / Math.max(reference.v, 0.05), 0.55, 1.8);

        for (let pixel = 0; pixel < weights.length; pixel += 1) {
            let weight = weights[pixel] * tint;
            if (weight <= 0) continue;
            const index = pixel * 4;
            const source = rgbToHsv(pixels[index], pixels[index + 1], pixels[index + 2]);

            /* Keep catchlights: very bright and almost colorless pixels. */
            if (source.v > 0.85 && source.s < 0.18 && source.v - reference.v > 0.35) {
                weight *= 0.25;
            }

            const saturation = clamp(target.s + (source.s - reference.s) * 0.5, 0, 1);
            const value = clamp(target.v + (source.v - reference.v) * valueGain, 0.02, 1);
            const colored = hsvToRgb(target.h, saturation, value);

            pixels[index] = Math.round(pixels[index] * (1 - weight) + colored.r * weight);
            pixels[index + 1] = Math.round(pixels[index + 1] * (1 - weight) + colored.g * weight);
            pixels[index + 2] = Math.round(pixels[index + 2] * (1 - weight) + colored.b * weight);
        }
    }

    function paletteColor(group, choice) {
        const customHex = normalizeHex(choice);
        if (customHex) return customHex;

        const palette = palettes[group] || {};
        const normalized = clean(choice);
        if (palette[normalized]) return palette[normalized];

        const fallbackName = config.defaultColors[group];
        const fallback = normalizeHex(fallbackName) || palette[clean(fallbackName)];
        if (!fallback) throw new Error(`Invalid default ${group} color: ${fallbackName}`);
        if (choice != null && choice !== "") {
            console.warn(`Invalid ${group} color; using ${fallbackName}:`, choice);
        }
        return fallback;
    }

    function tintFor(trait, value) {
        const number = Number(value);
        return Number.isFinite(number) && value !== "" && value != null
            ? clamp(number, 0, 100)
            : config.defaultTint;
    }

    /* ---------- rendering ---------- */

    function normalizeAppearance(appearance) {
        const normalized = {
            gender: clean(appearance.gender || config.defaultGender),
            muscularity: appearance.muscularity === true
                ? "muscular"
                : appearance.muscularity === false
                    ? "nonmuscular"
                    : clean(appearance.muscularity),
            tint: {}
        };
        /* Keep raw color values so hexadecimal numbers remain numbers. */
        traitNames().forEach(trait => {
            normalized[trait] = appearance[trait];
            normalized.tint[trait] = tintFor(trait, appearance.tint && appearance.tint[trait]);
        });
        return normalized;
    }

    async function render(appearance) {
        const requestNumber = ++renderSequence;
        const normalized = normalizeAppearance(appearance);
        const paths = assetPaths(normalized);
        const base = await loadImage(paths.base);
        const traits = traitNames();
        const missing = [];
        const masks = await Promise.all(traits.map(trait =>
            loadImage(paths.masks[trait]).catch(error => {
                missing.push(paths.masks[trait]);
                console.warn(error.message);
                return null;
            })));

        const canvas = document.createElement("canvas");
        canvas.width = base.naturalWidth;
        canvas.height = base.naturalHeight;
        canvas.className = "player-portrait-render";
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", "Player portrait");

        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(base, 0, 0);
        let pixels;
        try {
            pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        } catch (error) {
            readPixels(base, 1, 1); /* rethrows with the friendly message */
            throw error;
        }

        const emptyMasks = [];
        traits.forEach((trait, index) => {
            if (!masks[index]) return;
            const mask = maskWeights(paths.masks[trait], masks[index], canvas.width, canvas.height);
            if (mask.empty) {
                emptyMasks.push(paths.masks[trait]);
                return;
            }
            const color = paletteColor(trait, normalized[trait]);
            if (traitSetting(trait, "mode", "shade") === "hsv") {
                recolorHsv(pixels, mask.weights, color, normalized.tint[trait],
                    traitSetting(trait, "original", null));
            } else {
                recolorShade(pixels, mask.weights, color);
            }
        });

        context.putImageData(pixels, 0, 0);
        canvas.dataset.portraitKey = paths.key;
        canvas.dataset.renderSequence = String(requestNumber);
        canvas.portraitMissing = missing;
        canvas.portraitEmpty = emptyMasks;
        return canvas;
    }

    async function mount(target, appearance) {
        const element = typeof target === "string" ? document.querySelector(target) : target;
        if (!element) throw new Error("Player portrait target was not found.");
        const canvas = await render(appearance);
        element.replaceChildren(canvas);
        return canvas;
    }

    function cssUrl(url) {
        return `url("${String(url).replace(/["\\\n\r]/g, encodeURIComponent)}")`;
    }

    /* --player-eyes-color etc., so bubbles and other CSS can follow the player's colors. */
    function applyColorVariables(appearance) {
        const root = document.documentElement.style;
        traitNames().forEach(trait => {
            let color;
            try {
                color = paletteColor(trait, appearance[trait]);
            } catch (error) {
                return;
            }
            root.setProperty(`--player-${trait}-color`, color);
            root.setProperty(`--player-${trait}-text`, readableText(color));
        });
    }

    function showInPreviews(canvas) {
        document.querySelectorAll(config.selectors.preview).forEach(holder => {
            const copy = document.createElement("canvas");
            copy.width = canvas.width;
            copy.height = canvas.height;
            copy.className = canvas.className;
            copy.setAttribute("role", "img");
            copy.setAttribute("aria-label", "Player portrait");
            copy.getContext("2d").drawImage(canvas, 0, 0);
            holder.replaceChildren(copy);
            holder.classList.remove("is-empty");
        });
    }

    async function renderAndApply(appearance, selector) {
        applyColorVariables(appearance);
        const canvas = await render(appearance);

        /* Ignore an older render if the player changed options again meanwhile. */
        if (Number(canvas.dataset.renderSequence) !== renderSequence) {
            return { canvas, dataUrl: "", stale: true, missing: canvas.portraitMissing };
        }

        const dataUrl = canvas.toDataURL("image/png");

        /*
         * Keep the generated portrait available even when a custom chat image
         * is currently selected. This makes switching back to automatic instant.
         */
        currentDataUrl = dataUrl;
        lastSignature = signature(appearance);

        const player = storyVariables().p || {};

        /*
         * If $p.chatImageCustom contains an image path, use it for the chat
         * portrait. Otherwise use the automatically generated portrait.
         */
        const portraitUrl = player.chatImageCustom ? resolveImage(player.chatImageCustom) : dataUrl;

        /* Duplex's <<speech player>> bubble reads this variable. */
        document.documentElement.style.setProperty("--player-chat-portrait", cssUrl(portraitUrl));

        if (selector) {
            document.querySelectorAll(selector).forEach(element => {
                element.style.backgroundImage = cssUrl(portraitUrl);
            });
        }

        showInPreviews(canvas);
        return {
            canvas,
            dataUrl,
            portraitUrl,
            stale: false,
            missing: canvas.portraitMissing,
            empty: canvas.portraitEmpty
        };
    }

    /* ---------- story variables ---------- */

    function storyVariables() {
        return window.State && State.variables ? State.variables : {};
    }

    function truthy(value) {
        if (typeof value === "string") return /^(?:true|yes|y|1|muscular)\.?$/i.test(value.trim());
        return Boolean(value);
    }

    /*
     * Change this adapter if Astralscapes stores appearance values elsewhere.
     * Muscles are read from $p.muscles, then $p.muscular, then $p.body.muscular.
     * Colors come from $p.[trait].color and tint from $p.[trait].tint.
     */
    function appearanceFromStory() {
        const player = storyVariables().p || {};
        const muscles = player.muscles != null
            ? player.muscles
            : player.muscular != null
                ? player.muscular
                : player.body && player.body.muscular;
        const appearance = {
            gender: player.gender,
            muscularity: truthy(muscles) ? "muscular" : "nonmuscular",
            tint: {}
        };
        traitNames().forEach(trait => {
            const entry = player[trait] && typeof player[trait] === "object" ? player[trait] : {};
            appearance[trait] = entry.color;
            appearance.tint[trait] = entry.tint;
        });
        return appearance;
    }

    function signature(appearance) {
        const player = storyVariables().p || {};
        return JSON.stringify([normalizeAppearance(appearance), player.chatImageCustom || ""]);
    }

    function storyPlayer() {
        if (!window.State || !State.variables) {
            throw new Error("Story variables are unavailable. Open the builder after story startup.");
        }
        State.variables.p = State.variables.p || {};
        const player = State.variables.p;
        traitNames().forEach(trait => {
            if (!player[trait] || typeof player[trait] !== "object") player[trait] = {};
        });
        return player;
    }

    /*
     * Saves the color as a #rrggbb hex code in $p.[trait].color (so it can be
     * used directly as a color anywhere) and the swatch name, if any, in
     * $p.[trait].preset.
     */
    function setStoryColor(group, value) {
        const player = storyPlayer();
        const palette = palettes[group] || {};
        const preset = palette[clean(value)] ? clean(value) : "";
        const hex = preset ? palette[preset] : (normalizeHex(value) || paletteColor(group, config.defaultColors[group]));
        player[group].color = hex;
        player[group].preset = preset;
        applyColorVariables(appearanceFromStory());
        return hex;
    }

    function setStoryTint(group, value) {
        const player = storyPlayer();
        player[group].tint = tintFor(group, value);
        return player[group].tint;
    }

    /* ---------- the builder (one color picker per trait) ---------- */

    function scheduleRender(status, onChange) {
        window.clearTimeout(syncTimer);
        if (status) status.textContent = "Updating portrait…";
        syncTimer = window.setTimeout(() => {
            renderAndApply(appearanceFromStory())
                .then(result => {
                    if (result.stale) return;
                    if (status) {
                        const notes = [];
                        if (result.missing && result.missing.length) notes.push(`Missing mask: ${result.missing.join(", ")}`);
                        if (result.empty && result.empty.length) notes.push(`Mask has nothing painted on it: ${result.empty.join(", ")}`);
                        status.textContent = notes.length ? `Portrait updated. ${notes.join(". ")}` : "Portrait updated.";
                    }
                    if (typeof onChange === "function") onChange(appearanceFromStory(), result);
                })
                .catch(error => {
                    if (status) status.textContent = `Could not update portrait: ${error.message}`;
                    console.error(error);
                });
        }, config.renderDelay);
    }

    function makeSlider(name, label, max, unit) {
        const row = document.createElement("label");
        row.className = `portrait-slider portrait-slider-${name}`;
        const text = document.createElement("span");
        text.className = "portrait-slider-label";
        text.textContent = label;
        const input = document.createElement("input");
        input.type = "range";
        input.min = "0";
        input.max = String(max);
        input.step = "1";
        input.name = name;
        const output = document.createElement("output");
        output.className = "portrait-slider-value";
        row.appendChild(text);
        row.appendChild(input);
        row.appendChild(output);
        return {
            row,
            input,
            set(value) {
                input.value = String(Math.round(value));
                output.textContent = `${Math.round(value)}${unit}`;
            }
        };
    }

    function createColorControl(group, status, options) {
        const palette = palettes[group] || {};
        const useHsv = traitSetting(group, "controls", "basic") === "hsv";
        const wrapper = document.createElement("fieldset");
        wrapper.className = "portrait-color-control" + (useHsv ? " portrait-color-control--hsv" : "");
        wrapper.dataset.trait = group;

        const legend = document.createElement("legend");
        legend.textContent = traitSetting(group, "label", displayName(group));
        wrapper.appendChild(legend);

        const swatches = document.createElement("div");
        swatches.className = "portrait-swatches";
        swatches.setAttribute("role", "group");
        swatches.setAttribute("aria-label", `${legend.textContent} presets`);
        const swatchButtons = Object.keys(palette).map(name => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "portrait-swatch";
            button.dataset.color = name;
            button.style.setProperty("--swatch", palette[name]);
            button.title = displayName(name);
            button.setAttribute("aria-label", displayName(name));
            button.setAttribute("aria-pressed", "false");
            swatches.appendChild(button);
            return button;
        });
        wrapper.appendChild(swatches);

        const customRow = document.createElement("div");
        customRow.className = "portrait-custom-color";

        const pickerLabel = document.createElement("label");
        pickerLabel.className = "portrait-picker-label";
        const picker = document.createElement("input");
        picker.type = "color";
        picker.name = `portrait-${group}-picker`;
        pickerLabel.appendChild(picker);
        pickerLabel.appendChild(document.createTextNode("Pick any color"));
        customRow.appendChild(pickerLabel);

        const hexLabel = document.createElement("label");
        hexLabel.className = "portrait-hex-label";
        hexLabel.appendChild(document.createTextNode("Hex"));
        const hex = document.createElement("input");
        hex.type = "text";
        hex.name = `portrait-${group}-hex`;
        hex.inputMode = "text";
        hex.autocomplete = "off";
        hex.spellcheck = false;
        hex.maxLength = 7;
        hex.placeholder = "#rrggbb";
        hex.pattern = "#?[0-9a-fA-F]{6}";
        hexLabel.appendChild(hex);
        customRow.appendChild(hexLabel);
        wrapper.appendChild(customRow);

        /* Hue / Saturation / Value / Tint sliders */
        let sliders = null;
        const hsvState = { h: 0, s: 0, v: 0 };
        if (useHsv) {
            const box = document.createElement("div");
            box.className = "portrait-hsv";
            sliders = {
                h: makeSlider(`portrait-${group}-hue`, "Hue", 360, "°"),
                s: makeSlider(`portrait-${group}-saturation`, "Saturation", 100, "%"),
                v: makeSlider(`portrait-${group}-value`, "Value", 100, "%"),
                tint: makeSlider(`portrait-${group}-tint`, "Tint", 100, "%")
            };
            sliders.tint.row.title = "How strongly the color is painted over the art";
            Object.values(sliders).forEach(slider => box.appendChild(slider.row));
            wrapper.appendChild(box);
        }

        /* Live reading of the current color: dot, name, hex, preset and tint. */
        const name = document.createElement("p");
        name.className = "portrait-color-name";
        name.setAttribute("aria-live", "polite");
        const nameDot = document.createElement("span");
        nameDot.className = "portrait-color-dot";
        nameDot.setAttribute("aria-hidden", "true");
        const nameText = document.createElement("strong");
        nameText.className = "portrait-color-label";
        const nameMeta = document.createElement("span");
        nameMeta.className = "portrait-color-meta";
        name.appendChild(nameDot);
        name.appendChild(nameText);
        name.appendChild(nameMeta);
        wrapper.appendChild(name);

        function describe(color, preset) {
            nameDot.style.background = color;
            nameText.textContent = colorName(color);
            nameText.style.color = readableOnDark(color);
            const details = [color];
            if (preset && displayName(preset).toLowerCase() !== nameText.textContent.toLowerCase()) {
                details.push(`${displayName(preset)} preset`);
            }
            if (useHsv) {
                const tint = tintFor(group, storyPlayer()[group].tint);
                if (tint < 100) details.push(`${Math.round(tint)}% tint`);
            }
            nameMeta.textContent = details.join(" · ");
            wrapper.style.setProperty("--trait-color", color);
        }

        function paintTracks() {
            if (!sliders) return;
            const hueOnly = hsvToHex(hsvState.h, 1, 1);
            wrapper.style.setProperty("--hsv-hue", hueOnly);
            wrapper.style.setProperty("--hsv-s0", hsvToHex(hsvState.h, 0, hsvState.v));
            wrapper.style.setProperty("--hsv-s1", hsvToHex(hsvState.h, 1, hsvState.v));
            wrapper.style.setProperty("--hsv-v1", hsvToHex(hsvState.h, hsvState.s, 1));
            wrapper.style.setProperty("--hsv-color", hsvToHex(hsvState.h, hsvState.s, hsvState.v));
        }

        /* Show a color. keepHue: true when the sliders produced it (so grey keeps its hue). */
        function show(value, keepHue) {
            const preset = palette[clean(value)] ? clean(value) : null;
            const color = paletteColor(group, value);
            picker.value = color;
            hex.value = color;
            hex.setCustomValidity("");
            const matching = preset || Object.keys(palette).find(key => palette[key] === color) || null;
            swatchButtons.forEach(button => {
                button.setAttribute("aria-pressed", String(button.dataset.color === matching));
            });
            describe(color, matching);
            if (sliders) {
                if (!keepHue) {
                    const hsv = hexToHsv(color);
                    if (hsv.s > 0 && hsv.v > 0) hsvState.h = hsv.h;
                    hsvState.s = hsv.s;
                    hsvState.v = hsv.v;
                }
                sliders.h.set(hsvState.h * 360);
                sliders.s.set(hsvState.s * 100);
                sliders.v.set(hsvState.v * 100);
                sliders.tint.set(tintFor(group, storyPlayer()[group].tint));
                paintTracks();
            }
        }

        function rerender() {
            if (options.autoRender !== false) scheduleRender(status, options.onChange);
        }

        function commit(value, keepHue) {
            setStoryColor(group, value);
            show(value, keepHue);
            rerender();
        }

        swatchButtons.forEach(button => {
            button.addEventListener("click", () => commit(button.dataset.color));
        });
        picker.addEventListener("input", () => commit(picker.value));
        hex.addEventListener("change", () => {
            const normalized = normalizeHex(hex.value);
            if (!normalized) {
                hex.setCustomValidity("Enter a six-digit hex color such as #8b3f72.");
                hex.reportValidity();
                if (status) status.textContent = "That hex color is not valid.";
                return;
            }
            commit(normalized);
        });

        if (sliders) {
            const fromSliders = () => {
                hsvState.h = Number(sliders.h.input.value) / 360;
                hsvState.s = Number(sliders.s.input.value) / 100;
                hsvState.v = Number(sliders.v.input.value) / 100;
                commit(hsvToHex(hsvState.h, hsvState.s, hsvState.v), true);
            };
            sliders.h.input.addEventListener("input", fromSliders);
            sliders.s.input.addEventListener("input", fromSliders);
            sliders.v.input.addEventListener("input", fromSliders);
            sliders.tint.input.addEventListener("input", () => {
                setStoryTint(group, sliders.tint.input.value);
                sliders.tint.set(Number(sliders.tint.input.value));
                describe(picker.value, swatchButtons
                    .filter(button => button.getAttribute("aria-pressed") === "true")
                    .map(button => button.dataset.color)[0]);
                rerender();
            });
        }

        const current = () => {
            const entry = storyPlayer()[group];
            return entry.preset || entry.color || config.defaultColors[group];
        };
        show(current());
        wrapper.refresh = () => show(current());
        wrapper.resetTint = () => {
            if (useHsv) setStoryTint(group, config.defaultTint);
        };
        return wrapper;
    }

    function pickTraits(list) {
        const wanted = String(list || "").split(/[\s,]+/).map(clean).filter(Boolean);
        const known = traitNames();
        return wanted.length ? wanted.filter(trait => known.includes(trait)) : known;
    }

    /*
     * The color menu on its own (no preview). Options:
     *   title, traits ("hair eyes"), autoRender, onChange(appearance, result)
     */
    function mountColorMenu(target, options) {
        const mountPoint = typeof target === "string" ? document.querySelector(target) : target;
        if (!mountPoint) throw new Error("Portrait color-menu target was not found.");
        const settings = options || {};
        const menu = document.createElement("form");
        menu.className = "portrait-color-menu";
        menu.addEventListener("submit", event => event.preventDefault());

        if (settings.title !== "") {
            const title = document.createElement("h3");
            title.textContent = settings.title || "Portrait colors";
            menu.appendChild(title);
        }

        const status = document.createElement("p");
        status.className = "portrait-color-status";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");

        const controls = pickTraits(settings.traits).map(group => {
            const control = createColorControl(group, status, settings);
            menu.appendChild(control);
            return control;
        });

        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "portrait-color-reset";
        reset.textContent = "Restore default colors";
        reset.addEventListener("click", () => {
            controls.forEach(control => {
                setStoryColor(control.dataset.trait, config.defaultColors[control.dataset.trait]);
                control.resetTint();
                control.refresh();
            });
            if (settings.autoRender !== false) scheduleRender(status, settings.onChange);
        });
        menu.appendChild(reset);
        menu.appendChild(status);
        mountPoint.replaceChildren(menu);
        menu.status = status;
        return menu;
    }

    /*
     * Live preview + color menu. Used automatically for every
     * <div data-portrait-builder></div>. Attributes on that div:
     *   data-portrait-builder="hair eyes"   only show these traits
     *   data-title="Your look"             heading text ("" hides it)
     */
    function mountBuilder(target, options) {
        const mountPoint = typeof target === "string" ? document.querySelector(target) : target;
        if (!mountPoint) throw new Error("Portrait builder target was not found.");
        const settings = Object.assign({}, options);
        if (settings.traits == null) settings.traits = mountPoint.getAttribute("data-portrait-builder");
        if (settings.title == null && mountPoint.hasAttribute("data-title")) {
            settings.title = mountPoint.getAttribute("data-title");
        }
        if (settings.title == null) settings.title = "Your look";

        const builder = document.createElement("div");
        builder.className = "portrait-builder";

        const preview = document.createElement("div");
        preview.className = "portrait-preview is-empty";
        preview.setAttribute("data-portrait-preview", "");
        const placeholder = document.createElement("span");
        placeholder.className = "portrait-preview-placeholder";
        placeholder.textContent = "Drawing portrait…";
        preview.appendChild(placeholder);

        const menuHolder = document.createElement("div");
        menuHolder.className = "portrait-builder-controls";

        builder.appendChild(preview);
        builder.appendChild(menuHolder);
        mountPoint.replaceChildren(builder);
        mountPoint.dataset.portraitMounted = "true";

        storyPlayer();
        const menu = mountColorMenu(menuHolder, settings);
        scheduleRender(menu.status, settings.onChange);
        return builder;
    }

    /* ---------- Duplex hook ---------- */

    function mountPlaceholders() {
        document.querySelectorAll(config.selectors.builder).forEach(element => {
            if (element.dataset.portraitMounted === "true") return;
            try {
                mountBuilder(element);
            } catch (error) {
                element.textContent = `Portrait builder error: ${error.message}`;
                console.error(error);
            }
        });
        document.querySelectorAll(config.selectors.preview).forEach(element => {
            if (!element.firstChild && currentDataUrl) {
                const image = document.createElement("img");
                image.className = "player-portrait-render";
                image.alt = "Player portrait";
                image.src = currentDataUrl;
                element.appendChild(image);
            }
        });
    }

    /*
     * Redraw when the look changed outside the builder: going Back, loading
     * a save, restarting, <<set $p.hair.color to "#793d2e">>, or a
     * <<dropdown>>/<<checkbox>>/<<cycle>> for gender or muscles.
     */
    function syncWithStory() {
        mountPlaceholders();
        const appearance = appearanceFromStory();
        applyColorVariables(appearance);
        const needed = currentDataUrl
            || document.querySelector(config.selectors.avatar)
            || document.querySelector(config.selectors.preview);
        if (!needed) return;
        if (signature(appearance) === lastSignature) return;
        lastSignature = signature(appearance);
        scheduleRender(document.querySelector(".portrait-color-status"));
        document.querySelectorAll(".portrait-color-control").forEach(control => {
            if (typeof control.refresh === "function") control.refresh();
        });
    }

    /* Duplex fires :uiupdate after every passage is shown, after Back and after loading a save. */
    document.addEventListener(":uiupdate", syncWithStory);
    /* Duplex's own form macros run first (their listeners were added before Story JavaScript). */
    ["change", "click"].forEach(type => {
        document.addEventListener(type, event => {
            if (event.target.closest && event.target.closest("[data-duplex-action]")) syncWithStory();
        });
    });

    function clearCache() {
        imageCache.clear();
        maskCache.clear();
        lastSignature = "";
    }

    window.setup = window.setup || {};
    setup.playerPortrait = {
        palettes,
        config,
        render,
        mount,
        renderAndApply,
        appearanceFromStory,
        mountColorMenu,
        mountBuilder,
        mountPlaceholders,
        setStoryColor,
        setStoryTint,
        normalizeHex,
        colorName,
        clearCache,

        /* The chosen color's name, e.g. setup.playerPortrait.colorNameOf("eyes") -> "Sea Green". */
        colorNameOf(trait) {
            return colorName(paletteColor(trait, appearanceFromStory()[trait]));
        },

        /* The chosen color of a trait as #rrggbb, e.g. setup.playerPortrait.color("eyes"). */
        color(trait) {
            return paletteColor(trait, appearanceFromStory()[trait]);
        },

        /*
         * Set a custom chat portrait by image path.
         * Pass null, an empty string, or no value to return to automatic mode.
         *
         * Examples:
         *   setup.playerPortrait.setChatImage("img/player/custom/portrait-01.png");
         *   setup.playerPortrait.setChatImage(null);
         */
        setChatImage(path) {
            const player = storyPlayer();
            player.chatImageCustom = path || null;
            return renderAndApply(appearanceFromStory());
        },

        renderCurrent(selector) {
            return renderAndApply(appearanceFromStory(), selector);
        },

        getCurrentDataUrl() {
            return currentDataUrl;
        }
    };
}());
