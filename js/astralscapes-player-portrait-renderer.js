/*
 * Astralscapes dynamic player portrait renderer
 *
 * Expected default filenames:
 *   img/player/bases/[gender]_[muscularity]_base.png
 *   img/player/masks/[gender]_[muscularity]_skin_mask.png
 *   img/player/masks/[gender]_[muscularity]_hair-eyebrows_mask.png
 *   img/player/masks/[gender]_[muscularity]_eyes_mask.png
 *
 * Add this file to Story JavaScript, or load it before passages call the API.
 */
(function () {
    "use strict";

    const palettes = {
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
        },
        skin: {
            pale: "#f0ad80",
            olive: "#c58d63",
            brown: "#986344",
            dark: "#65402f"
        }
    };

    const config = {
        baseDirectory: "img/player/bases",
        maskDirectory: "img/player/masks",

        /* Used whenever a saved/custom value is empty or invalid. */
        defaultColors: {
            hair: "dark-brown",
            eyes: "brown",
            skin: "pale"
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

        selectors: {
            avatar: ".speech.player .avatar, .speech .avatar.player-avatar",
            canvas: "#player-portrait-canvas"
        }
    };

    const imageCache = new Map();
    let renderSequence = 0;
    let currentDataUrl = "";
    let menuRenderTimer = 0;

    function clean(value) {
        return String(value == null ? "" : value)
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "-");
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

    function loadImage(path) {
        if (!imageCache.has(path)) {
            imageCache.set(path, new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error(`Could not load portrait asset: ${path}`));
                image.src = path;
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

        return {
            key,
            base: join(config.baseDirectory, override.base || `${key}_base.png`),
            skin: join(config.maskDirectory, override.skin || `${key}_skin_mask.png`),
            hair: join(config.maskDirectory, override.hair || `${key}_hair-eyebrows_mask.png`),
            eyes: join(config.maskDirectory, override.eyes || `${key}_eyes_mask.png`)
        };
    }

    function imagePixels(image, width, height) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0, width, height);
        return context.getImageData(0, 0, width, height);
    }

    function recolorWithMask(baseData, maskData, hexColor) {
        const targetRgb = hexToRgb(hexColor);
        const targetHsl = rgbToHsl(targetRgb.r, targetRgb.g, targetRgb.b);
        let weightedLightness = 0;
        let totalWeight = 0;

        for (let index = 0; index < baseData.data.length; index += 4) {
            const weight = maskData.data[index + 3] / 255;
            if (weight <= 0) continue;
            const source = rgbToHsl(
                baseData.data[index],
                baseData.data[index + 1],
                baseData.data[index + 2]
            );
            weightedLightness += source.l * weight;
            totalWeight += weight;
        }

        const averageLightness = totalWeight ? weightedLightness / totalWeight : 0.5;

        for (let index = 0; index < baseData.data.length; index += 4) {
            const maskOpacity = maskData.data[index + 3] / 255;
            if (maskOpacity <= 0) continue;

            const source = rgbToHsl(
                baseData.data[index],
                baseData.data[index + 1],
                baseData.data[index + 2]
            );

            /* Keep the artwork's highlight/shadow distance from its average. */
            const lightness = Math.max(
                0.015,
                Math.min(0.985, targetHsl.l + (source.l - averageLightness) * 0.92)
            );
            const colored = hslToRgb(targetHsl.h, targetHsl.s, lightness);

            baseData.data[index] = Math.round(
                baseData.data[index] * (1 - maskOpacity) + colored.r * maskOpacity
            );
            baseData.data[index + 1] = Math.round(
                baseData.data[index + 1] * (1 - maskOpacity) + colored.g * maskOpacity
            );
            baseData.data[index + 2] = Math.round(
                baseData.data[index + 2] * (1 - maskOpacity) + colored.b * maskOpacity
            );
        }
    }

    function paletteColor(group, choice) {
        const customHex = normalizeHex(choice);
        if (customHex) return customHex;

        const normalized = clean(choice);
        const color = palettes[group][normalized];
        if (color) return color;

        const fallbackName = config.defaultColors[group];
        const fallback = normalizeHex(fallbackName) || palettes[group][clean(fallbackName)];
        if (!fallback) throw new Error(`Invalid default ${group} color: ${fallbackName}`);
        console.warn(`Invalid ${group} color; using ${fallbackName}:`, choice);
        return fallback;
    }

    async function render(appearance) {
        const requestNumber = ++renderSequence;
        const normalized = {
            gender: clean(appearance.gender),
            muscularity: appearance.muscularity === true
                ? "muscular"
                : appearance.muscularity === false
                    ? "nonmuscular"
                    : clean(appearance.muscularity),
            /* Keep raw color values so hexadecimal numbers remain numbers. */
            hair: appearance.hair,
            eyes: appearance.eyes,
            skin: appearance.skin
        };
        const paths = assetPaths(normalized);
        const [base, skinMask, hairMask, eyeMask] = await Promise.all([
            loadImage(paths.base),
            loadImage(paths.skin),
            loadImage(paths.hair),
            loadImage(paths.eyes)
        ]);

        const canvas = document.createElement("canvas");
        canvas.width = base.naturalWidth;
        canvas.height = base.naturalHeight;
        canvas.className = "player-portrait-render";
        canvas.setAttribute("aria-label", "Player portrait");

        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(base, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);

        recolorWithMask(pixels, imagePixels(skinMask, canvas.width, canvas.height),
            paletteColor("skin", normalized.skin));
        recolorWithMask(pixels, imagePixels(hairMask, canvas.width, canvas.height),
            paletteColor("hair", normalized.hair));
        recolorWithMask(pixels, imagePixels(eyeMask, canvas.width, canvas.height),
            paletteColor("eyes", normalized.eyes));

        context.putImageData(pixels, 0, 0);
        canvas.dataset.portraitKey = paths.key;
        canvas.dataset.renderSequence = String(requestNumber);
        return canvas;
    }

    async function mount(target, appearance) {
        const element = typeof target === "string" ? document.querySelector(target) : target;
        if (!element) throw new Error("Player portrait target was not found.");
        const canvas = await render(appearance);
        element.replaceChildren(canvas);
        return canvas;
    }

    async function renderAndApply(appearance, selector) {
        const canvas = await render(appearance);
        const dataUrl = canvas.toDataURL("image/png");

        /* Ignore an older render if the player changed options again meanwhile. */
        if (Number(canvas.dataset.renderSequence) !== renderSequence) {
            return { canvas, dataUrl, stale: true };
        }

        /*
         * Keep the generated portrait available even when a custom chat image
         * is currently selected. This makes switching back to automatic instant.
         */
        currentDataUrl = dataUrl;

        const variables = window.State && State.variables ? State.variables : {};
        const player = variables.p || {};

        /*
         * If $p.chatImageCustom contains an image path, use it for the chat
         * portrait. Otherwise use the automatically generated portrait.
         */
        const portraitUrl = player.chatImageCustom || dataUrl;

        document.documentElement.style.setProperty(
            "--player-chat-portrait",
            `url("${portraitUrl}")`
        );

        const targets = document.querySelectorAll(selector || config.selectors.avatar);
        targets.forEach(element => {
            element.style.backgroundImage = `url("${portraitUrl}")`;
        });

        return { canvas, dataUrl, portraitUrl, stale: false };
    }

    /*
     * Change this adapter if Astralscapes stores appearance values elsewhere.
     * It expects $p.gender, $p.body.muscular, $p.hair.color, $p.eyes.color,
     * and $p.skin.color by default.
     */
    function appearanceFromStory() {
        const variables = window.State && State.variables ? State.variables : {};
        const player = variables.p || {};
        return {
            gender: player.gender,
            muscularity: player.body && player.body.muscular
                ? "muscular"
                : "nonmuscular",
            hair: player.hair && player.hair.color,
            eyes: player.eyes && player.eyes.color,
            skin: player.skin && player.skin.color
        };
    }

    function displayName(value) {
        return String(value)
            .split("-")
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
    }

    function storyPlayer() {
        if (!window.State || !State.variables) {
            throw new Error("Story variables are unavailable. Open the menu after story startup.");
        }
        State.variables.p = State.variables.p || {};
        const player = State.variables.p;
        player.hair = player.hair || {};
        player.eyes = player.eyes || {};
        player.skin = player.skin || {};
        return player;
    }

    function setStoryColor(group, value) {
        const player = storyPlayer();
        const validPreset = palettes[group][clean(value)];
        const validHex = normalizeHex(value);
        player[group].color = validPreset ? clean(value) : (validHex || config.defaultColors[group]);
        return player[group].color;
    }

    function scheduleMenuRender(status, onChange) {
        window.clearTimeout(menuRenderTimer);
        status.textContent = "Updating portrait…";
        menuRenderTimer = window.setTimeout(() => {
            renderAndApply(appearanceFromStory())
                .then(result => {
                    if (!result.stale) status.textContent = "Portrait updated.";
                    if (typeof onChange === "function") onChange(appearanceFromStory(), result);
                })
                .catch(error => {
                    status.textContent = `Could not update portrait: ${error.message}`;
                    console.error(error);
                });
        }, 90);
    }

    function createColorControl(group, status, options) {
        const wrapper = document.createElement("fieldset");
        wrapper.className = "portrait-color-control";

        const legend = document.createElement("legend");
        legend.textContent = `${displayName(group)} color`;
        wrapper.appendChild(legend);

        const selectLabel = document.createElement("label");
        selectLabel.textContent = "Preset";
        const select = document.createElement("select");
        select.name = `portrait-${group}-preset`;
        Object.keys(palettes[group]).forEach(name => {
            const option = document.createElement("option");
            option.value = name;
            option.textContent = displayName(name);
            select.appendChild(option);
        });
        const customOption = document.createElement("option");
        customOption.value = "__custom__";
        customOption.textContent = "Custom…";
        select.appendChild(customOption);
        selectLabel.appendChild(select);
        wrapper.appendChild(selectLabel);

        const customRow = document.createElement("div");
        customRow.className = "portrait-custom-color";

        const pickerLabel = document.createElement("label");
        pickerLabel.textContent = "Picker";
        const picker = document.createElement("input");
        picker.type = "color";
        picker.name = `portrait-${group}-picker`;
        pickerLabel.appendChild(picker);
        customRow.appendChild(pickerLabel);

        const hexLabel = document.createElement("label");
        hexLabel.textContent = "Hex code";
        const hex = document.createElement("input");
        hex.type = "text";
        hex.name = `portrait-${group}-hex`;
        hex.inputMode = "text";
        hex.maxLength = 7;
        hex.placeholder = "#rrggbb";
        hex.pattern = "#[0-9a-fA-F]{6}";
        hexLabel.appendChild(hex);
        customRow.appendChild(hexLabel);
        wrapper.appendChild(customRow);

        const current = appearanceFromStory()[group];
        const currentPreset = palettes[group][clean(current)] ? clean(current) : null;
        const currentHex = normalizeHex(current)
            || paletteColor(group, current || config.defaultColors[group]);
        select.value = currentPreset || "__custom__";
        picker.value = currentHex;
        hex.value = currentHex;
        customRow.hidden = Boolean(currentPreset);

        function commitCustom(value) {
            const normalized = normalizeHex(value);
            if (!normalized) {
                hex.setCustomValidity("Enter a six-digit hex color such as #8b3f72.");
                status.textContent = "That hex color is not valid.";
                return;
            }
            hex.setCustomValidity("");
            picker.value = normalized;
            hex.value = normalized;
            select.value = "__custom__";
            customRow.hidden = false;
            setStoryColor(group, normalized);
            if (options.autoRender !== false) scheduleMenuRender(status, options.onChange);
        }

        select.addEventListener("change", () => {
            const isCustom = select.value === "__custom__";
            customRow.hidden = !isCustom;
            if (isCustom) {
                commitCustom(hex.value || picker.value);
            } else {
                const selectedHex = palettes[group][select.value];
                picker.value = selectedHex;
                hex.value = selectedHex;
                setStoryColor(group, select.value);
                if (options.autoRender !== false) scheduleMenuRender(status, options.onChange);
            }
        });
        picker.addEventListener("input", () => commitCustom(picker.value));
        hex.addEventListener("change", () => commitCustom(hex.value));

        return wrapper;
    }

    function mountColorMenu(target, options) {
        const mountPoint = typeof target === "string" ? document.querySelector(target) : target;
        if (!mountPoint) throw new Error("Portrait color-menu target was not found.");
        const settings = options || {};
        const menu = document.createElement("form");
        menu.className = "portrait-color-menu";
        menu.addEventListener("submit", event => event.preventDefault());

        const title = document.createElement("h3");
        title.textContent = settings.title || "Portrait colors";
        menu.appendChild(title);

        const status = document.createElement("p");
        status.className = "portrait-color-status";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");

        ["skin", "hair", "eyes"].forEach(group => {
            menu.appendChild(createColorControl(group, status, settings));
        });

        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "portrait-color-reset";
        reset.textContent = "Restore default colors";
        reset.addEventListener("click", () => {
            Object.entries(config.defaultColors).forEach(([group, value]) => {
                setStoryColor(group, value);
            });
            mountColorMenu(mountPoint, settings);
            if (settings.autoRender !== false) {
                const newStatus = mountPoint.querySelector(".portrait-color-status");
                scheduleMenuRender(newStatus, settings.onChange);
            }
        });
        menu.appendChild(reset);
        menu.appendChild(status);
        mountPoint.replaceChildren(menu);
        return menu;
    }

    function clearCache() {
        imageCache.clear();
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
