
import * as pretext from './pretext-layout.js';

const text = {};

text._parsePixels = (value, fallback) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const match = value.match(/(-?\d+(?:\.\d+)?)\s*px/i);
        if (match) {
            const number = Number.parseFloat(match[1]);
            if (Number.isFinite(number)) {
                return number;
            }
        }
    }
    return fallback;
};

text._parseFontSize = (font, fallback = 12) => {
    if (typeof font !== 'string' || font.length === 0) {
        return fallback;
    }
    const match = font.match(/(\d+(?:\.\d+)?)\s*px/i);
    if (!match) {
        return fallback;
    }
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) ? value : fallback;
};

text._normalizeLineHeight = (lineHeight, font) => {
    const fontSize = text._parseFontSize(font, 12);
    if (typeof lineHeight === 'number' && Number.isFinite(lineHeight)) {
        return lineHeight;
    }
    if (typeof lineHeight === 'string') {
        if (lineHeight === 'normal') {
            return fontSize * 1.2;
        }
        const px = text._parsePixels(lineHeight, null);
        if (px !== null) {
            return px;
        }
    }
    return fontSize * 1.2;
};

text._round = (value) => {
    return Math.round(value * 1000) / 1000;
};

text.TextLayoutService = class {

    constructor() {
        this._preparedCache = new Map();
        this._maxPreparedEntries = 10000;
        this._canvasContext = null;
        this._shadowStats = {
            count: 0,
            totalDelta: 0,
            maxDelta: 0,
            logged: 0
        };
    }

    _config() {
        if (typeof window !== 'undefined' && window.NETRON_CONFIG) {
            return window.NETRON_CONFIG;
        }
        return null;
    }

    mode() {
        const config = this._config();
        const mode = config && typeof config.textLayoutEngine === 'string' ? config.textLayoutEngine : 'legacy';
        switch (mode) {
            case 'legacy':
            case 'shadow':
            case 'pretext':
                return mode;
            default:
                return 'legacy';
        }
    }

    strictParity() {
        const config = this._config();
        return !config || config.textLayoutStrictParity !== false;
    }

    shadowSampleRate() {
        const config = this._config();
        const value = config ? Number(config.textLayoutShadowSampleRate) : 0.05;
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.05;
    }

    _getCanvasContext() {
        if (this._canvasContext) {
            return this._canvasContext;
        }
        if (typeof OffscreenCanvas !== 'undefined') {
            this._canvasContext = new OffscreenCanvas(1, 1).getContext('2d');
            return this._canvasContext;
        }
        if (typeof document !== 'undefined') {
            const canvas = document.createElement('canvas');
            this._canvasContext = canvas.getContext('2d');
            return this._canvasContext;
        }
        return null;
    }

    _measureLegacy(element, textContent, font) {
        if (element && typeof element.getBBox === 'function') {
            try {
                const box = element.getBBox();
                if (Number.isFinite(box.width) && Number.isFinite(box.height) && Number.isFinite(box.y)) {
                    return {
                        width: box.width,
                        height: box.height,
                        y: box.y,
                        engine: 'legacy'
                    };
                }
            } catch {
                // fall through to canvas fallback
            }
        }
        const context = this._getCanvasContext();
        if (context && typeof context.measureText === 'function') {
            if (font) {
                context.font = font;
            }
            const metrics = context.measureText(textContent || '');
            const fontSize = text._parseFontSize(font, 12);
            const ascent = Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : fontSize * 0.8;
            const descent = Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : fontSize * 0.2;
            const height = ascent + descent;
            return {
                width: metrics.width,
                height,
                y: -ascent,
                engine: 'legacy-canvas'
            };
        }
        const fallbackSize = text._parseFontSize(font, 12);
        const width = (textContent || '').length * fallbackSize * 0.6;
        return {
            width,
            height: fallbackSize,
            y: -fallbackSize * 0.8,
            engine: 'legacy-fallback'
        };
    }

    _preparedKey(textContent, font, whiteSpace) {
        return `${font}\u0000${whiteSpace}\u0000${textContent}`;
    }

    _getPrepared(textContent, font, whiteSpace) {
        const key = this._preparedKey(textContent, font, whiteSpace);
        if (this._preparedCache.has(key)) {
            const prepared = this._preparedCache.get(key);
            // LRU touch
            this._preparedCache.delete(key);
            this._preparedCache.set(key, prepared);
            return prepared;
        }
        const prepared = pretext.prepareWithSegments(textContent, font, { whiteSpace });
        this._preparedCache.set(key, prepared);
        if (this._preparedCache.size > this._maxPreparedEntries) {
            const firstKey = this._preparedCache.keys().next().value;
            if (firstKey !== undefined) {
                this._preparedCache.delete(firstKey);
            }
        }
        return prepared;
    }

    _measurePretext(textContent, font, lineHeight, whiteSpace) {
        const prepared = this._getPrepared(textContent, font, whiteSpace);
        const maxWidth = 1e9;
        const layout = pretext.layoutWithLines(prepared, maxWidth, lineHeight);
        let width = 0;
        for (const line of layout.lines) {
            width = Math.max(width, line.width);
        }
        const fontSize = text._parseFontSize(font, 12);
        const ascent = Math.min(lineHeight, Math.max(1, fontSize * 0.8));
        return {
            width,
            height: layout.height > 0 ? layout.height : lineHeight,
            y: -ascent,
            lineCount: layout.lineCount,
            engine: 'pretext'
        };
    }

    _recordShadowDelta(legacy, pretextMetrics, textContent, font) {
        if (!legacy || !pretextMetrics || !Number.isFinite(legacy.width) || !Number.isFinite(pretextMetrics.width)) {
            return;
        }
        const delta = Math.abs(legacy.width - pretextMetrics.width);
        this._shadowStats.count += 1;
        this._shadowStats.totalDelta += delta;
        this._shadowStats.maxDelta = Math.max(this._shadowStats.maxDelta, delta);

        const config = this._config();
        if (!config || !config.textLayoutShadowLog || this._shadowStats.logged >= 8) {
            return;
        }
        const threshold = Number.isFinite(config.textLayoutShadowLogThresholdPx) ? config.textLayoutShadowLogThresholdPx : 4;
        if (delta < threshold) {
            return;
        }
        this._shadowStats.logged += 1;
        const preview = textContent.length > 80 ? `${textContent.slice(0, 77)}...` : textContent;
        // eslint-disable-next-line no-console
        console.warn('[TextLayoutService] shadow delta', {
            delta: text._round(delta),
            legacy: text._round(legacy.width),
            pretext: text._round(pretextMetrics.width),
            font,
            text: preview
        });
    }

    measureTextElement(element, options = {}) {
        let textContent = '';
        if (Object.prototype.hasOwnProperty.call(options, 'text')) {
            textContent = String(options.text);
        } else if (element && element.textContent) {
            textContent = element.textContent;
        }
        const font = options.font || '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const whiteSpace = options.whiteSpace === 'pre-wrap' ? 'pre-wrap' : 'normal';
        const lineHeight = text._normalizeLineHeight(options.lineHeight, font);

        const legacy = this._measureLegacy(element, textContent, font);
        const mode = this.mode();

        if (mode === 'legacy') {
            return {
                width: legacy.width,
                height: legacy.height,
                y: legacy.y,
                engine: 'legacy',
                legacy,
                pretext: null
            };
        }

        let pretextMetrics = null;
        try {
            pretextMetrics = this._measurePretext(textContent, font, lineHeight, whiteSpace);
        } catch {
            if (mode === 'pretext') {
                return {
                    width: legacy.width,
                    height: legacy.height,
                    y: legacy.y,
                    engine: 'pretext-fallback',
                    legacy,
                    pretext: null
                };
            }
            return {
                width: legacy.width,
                height: legacy.height,
                y: legacy.y,
                engine: 'shadow-fallback',
                legacy,
                pretext: null
            };
        }

        if (mode === 'shadow') {
            const sampleRate = this.shadowSampleRate();
            if (Math.random() <= sampleRate) {
                this._recordShadowDelta(legacy, pretextMetrics, textContent, font);
            }
            return {
                width: legacy.width,
                height: legacy.height,
                y: legacy.y,
                engine: 'shadow',
                legacy,
                pretext: pretextMetrics
            };
        }

        // pretext mode
        if (this.strictParity() && Number.isFinite(legacy.width) && Number.isFinite(pretextMetrics.width)) {
            const delta = Math.abs(legacy.width - pretextMetrics.width);
            const allowed = Math.max(2, legacy.width * 0.12);
            if (delta > allowed) {
                return {
                    width: legacy.width,
                    height: legacy.height,
                    y: legacy.y,
                    engine: 'pretext-fallback-delta',
                    legacy,
                    pretext: pretextMetrics
                };
            }
        }

        return {
            width: pretextMetrics.width,
            height: pretextMetrics.height,
            y: pretextMetrics.y,
            engine: 'pretext',
            legacy,
            pretext: pretextMetrics
        };
    }

    clearCache() {
        this._preparedCache.clear();
        pretext.clearCache();
    }

    setLocale(locale) {
        pretext.setLocale(locale);
        this._preparedCache.clear();
    }

    getShadowStats() {
        const count = this._shadowStats.count;
        const mean = count > 0 ? this._shadowStats.totalDelta / count : 0;
        return {
            count,
            meanDelta: text._round(mean),
            maxDelta: text._round(this._shadowStats.maxDelta)
        };
    }
};

let shared = null;

text.getTextLayoutService = () => {
    if (!shared) {
        shared = new text.TextLayoutService();
    }
    return shared;
};

export const TextLayoutService = text.TextLayoutService;
export const getTextLayoutService = text.getTextLayoutService;
