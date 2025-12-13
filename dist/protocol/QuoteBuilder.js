"use strict";
/**
 * QuoteBuilder - AIP-2 Price Quote Construction
 *
 * This module re-exports the full QuoteBuilder implementation from builders/
 * Reference: AIP-2 §6.1
 *
 * @deprecated Import from builders/QuoteBuilder directly
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIP2QuoteTypes = exports.QuoteBuilder = void 0;
var QuoteBuilder_1 = require("../builders/QuoteBuilder");
Object.defineProperty(exports, "QuoteBuilder", { enumerable: true, get: function () { return QuoteBuilder_1.QuoteBuilder; } });
Object.defineProperty(exports, "AIP2QuoteTypes", { enumerable: true, get: function () { return QuoteBuilder_1.AIP2QuoteTypes; } });
//# sourceMappingURL=QuoteBuilder.js.map