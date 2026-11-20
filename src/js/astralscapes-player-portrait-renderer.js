/*
 * Astralscapes dynamic player portrait renderer (Duplex 1.10.0 edition)
 *
 * Put this whole file in a passage tagged "script" (Story JavaScript).
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
            green: "#56875a",
            amber: "#b77a32",
            brown: "#654332",
            hazel: "#817046",
            blue: "#4f80a6",
            grey: "#858b91"
        }
    };

    const config = {
        baseDirectory: "img/player/bases",
        maskDirectory: "img/player/masks",

        /*
         * Every changeable trait, in the order it is painted and shown in the
         * builder. Each one is stored in $p.[trait].color and painted through
         * the mask file "[gender]_[muscularity]_[mask].png".
         *
         * To add a trait (for example lips), add a palette above, a default
         * color below, an entry here, and the mask picture:
         *   lips: { label: "Lips", mask: "lips_mask" }
         */
        traits: {
            skin: { label: "Skin", mask: "skin_mask" },
            hair: { label: "Hair & eyebrows", mask: "hair-eyebrows_mask" },
            eyes: { label: "Eyes", mask: "eyes_mask" }
        },

        /* Used whenever a saved/custom value is empty or invalid. */
        defaultColors: {
            skin: "pale",
            hair: "dark-brown",
            eyes: "brown"
        },

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

        /* Used when $p.gender is empty. */
        defaultGender: "",

        /* Milliseconds to wait after the last color change before redrawing. */
        renderDelay: 90,

        selectors: {
            /* Duplex's <<speech player>> portrait. */
            avatar: ".duplex-speech-player",
            builder: "[data-portrait-builder]",
            preview: "[data-portrait-preview]"
        }
    };

    const imageCache = new Map();
    const pixelCache = new Map();
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

    function traitNames() {
        return Object.keys(config.traits);
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

    function displayName(value) {
        return String(value)
            .split("-")
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
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

    /* Mask transparency only, cached per mask so color changes stay fast. */
    function maskAlpha(path, image, width, height) {
        const cacheKey = `${path}@${width}x${height}`;
        if (!pixelCache.has(cacheKey)) {
            const data = readPixels(image, width, height).data;
            const alpha = new Uint8ClampedArray(width * height);
            for (let index = 0; index < alpha.length; index += 1) {
                alpha[index] = data[index * 4 + 3];
            }
            pixelCache.set(cacheKey, alpha);
        }
        return pixelCache.get(cacheKey);
    }

    function recolorWithMask(baseData, alpha, hexColor) {
        const targetRgb = hexToRgb(hexColor);
        const targetHsl = rgbToHsl(targetRgb.r, targetRgb.g, targetRgb.b);
        const pixels = baseData.data;
        let weightedLightness = 0;
        let totalWeight = 0;

        for (let pixel = 0; pixel < alpha.length; pixel += 1) {
            const weight = alpha[pixel] / 255;
            if (weight <= 0) continue;
            const index = pixel * 4;
            const source = rgbToHsl(pixels[index], pixels[index + 1], pixels[index + 2]);
            weightedLightness += source.l * weight;
            totalWeight += weight;
        }

        const averageLightness = totalWeight ? weightedLightness / totalWeight : 0.5;

        for (let pixel = 0; pixel < alpha.length; pixel += 1) {
            const maskOpacity = alpha[pixel] / 255;
            if (maskOpacity <= 0) continue;
            const index = pixel * 4;
            const source = rgbToHsl(pixels[index], pixels[index + 1], pixels[index + 2]);

            /* Keep the artwork's highlight/shadow distance from its average. */
            const lightness = Math.max(
                0.015,
                Math.min(0.985, targetHsl.l + (source.l - averageLightness) * 0.92)
            );
            const colored = hslToRgb(targetHsl.h, targetHsl.s, lightness);

            pixels[index] = Math.round(pixels[index] * (1 - maskOpacity) + colored.r * maskOpacity);
            pixels[index + 1] = Math.round(pixels[index + 1] * (1 - maskOpacity) + colored.g * maskOpacity);
            pixels[index + 2] = Math.round(pixels[index + 2] * (1 - maskOpacity) + colored.b * maskOpacity);
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

    /* ---------- rendering ---------- */

    function normalizeAppearance(appearance) {
        const normalized = {
            gender: clean(appearance.gender || config.defaultGender),
            muscularity: appearance.muscularity === true
                ? "muscular"
                : appearance.muscularity === false
                    ? "nonmuscular"
                    : clean(appearance.muscularity)
        };
        /* Keep raw color values so hexadecimal numbers remain numbers. */
        traitNames().forEach(trait => { normalized[trait] = appearance[trait]; });
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

        traits.forEach((trait, index) => {
            if (!masks[index]) return;
            const alpha = maskAlpha(paths.masks[trait], masks[index], canvas.width, canvas.height);
            recolorWithMask(pixels, alpha, paletteColor(trait, normalized[trait]));
        });

        context.putImageData(pixels, 0, 0);
        canvas.dataset.portraitKey = paths.key;
        canvas.dataset.renderSequence = String(requestNumber);
        canvas.portraitMissing = missing;
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
        return { canvas, dataUrl, portraitUrl, stale: false, missing: canvas.portraitMissing };
    }

    /* ---------- story variables ---------- */

    function storyVariables() {
        return window.State && State.variables ? State.variables : {};
    }

    /*
     * Change this adapter if Astralscapes stores appearance values elsewhere.
     * It expects $p.gender, $p.body.muscular and $p.[trait].color
     * ($p.skin.color, $p.hair.color, $p.eyes.color) by default.
     */
    function appearanceFromStory() {
        const player = storyVariables().p || {};
        const appearance = {
            gender: player.gender,
            muscularity: player.body && player.body.muscular
                ? "muscular"
                : "nonmuscular"
        };
        traitNames().forEach(trait => {
            appearance[trait] = player[trait] && player[trait].color;
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

    function setStoryColor(group, value) {
        const player = storyPlayer();
        const palette = palettes[group] || {};
        const validPreset = palette[clean(value)];
        const validHex = normalizeHex(value);
        player[group].color = validPreset ? clean(value) : (validHex || config.defaultColors[group]);
        return player[group].color;
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
                        status.textContent = result.missing && result.missing.length
                            ? `Portrait updated. Missing mask: ${result.missing.join(", ")}`
                            : "Portrait updated.";
                    }
                    if (typeof onChange === "function") onChange(appearanceFromStory(), result);
                })
                .catch(error => {
                    if (status) status.textContent = `Could not update portrait: ${error.message}`;
                    console.error(error);
                });
        }, config.renderDelay);
    }

    function createColorControl(group, status, options) {
        const palette = palettes[group] || {};
        const wrapper = document.createElement("fieldset");
        wrapper.className = "portrait-color-control";
        wrapper.dataset.trait = group;

        const legend = document.createElement("legend");
        legend.textContent = (config.traits[group] && config.traits[group].label) || displayName(group);
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

        const name = document.createElement("p");
        name.className = "portrait-color-name";
        wrapper.appendChild(name);

        function show(value) {
            const preset = palette[clean(value)] ? clean(value) : null;
            const color = paletteColor(group, value);
            picker.value = color;
            hex.value = color;
            hex.setCustomValidity("");
            swatchButtons.forEach(button => {
                button.setAttribute("aria-pressed", String(button.dataset.color === preset));
            });
            name.textContent = preset ? displayName(preset) : `Custom ${color}`;
        }

        function commit(value) {
            setStoryColor(group, value);
            show(storyPlayer()[group].color);
            if (options.autoRender !== false) scheduleRender(status, options.onChange);
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

        show(appearanceFromStory()[group] || config.defaultColors[group]);
        wrapper.refresh = () => show(appearanceFromStory()[group] || config.defaultColors[group]);
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

        const menu = mountColorMenu(menuHolder, settings);
        storyPlayer();
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
     * a save, restarting, <<set $p.hair.color to "auburn">>, or a
     * <<dropdown>>/<<checkbox>> for gender or muscles.
     */
    function syncWithStory() {
        mountPlaceholders();
        const needed = currentDataUrl
            || document.querySelector(config.selectors.avatar)
            || document.querySelector(config.selectors.preview);
        if (!needed) return;
        const appearance = appearanceFromStory();
        if (signature(appearance) === lastSignature) return;
        lastSignature = signature(appearance);
        scheduleRender(document.querySelector(".portrait-color-status"));
        document.querySelectorAll(".portrait-color-control").forEach(control => {
            if (typeof control.refresh === "function") control.refresh();
        });
    }

    /* Duplex fires :uiupdate after every passage is shown, after Back and after loading a save. */
    document.addEventListener(":uiupdate", syncWithStory);
    /* Duplex's own form macros run first (their listener was added before Story JavaScript). */
    document.addEventListener("change", event => {
        if (event.target.closest && event.target.closest("[data-duplex-action]")) syncWithStory();
    });

    function clearCache() {
        imageCache.clear();
        pixelCache.clear();
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
        normalizeHex,
        clearCache,

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
