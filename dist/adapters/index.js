"use strict";
/**
 * Adapter Layer - Bridges user-friendly API to protocol-level SDK
 *
 * This module exports all adapter classes and types for the Three-Level API:
 * - BaseAdapter: Abstract base with shared utilities
 * - BeginnerAdapter: High-level, opinionated API
 * - IntermediateAdapter: Balanced control API
 *
 * @module adapters
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntermediateAdapter = exports.BeginnerAdapter = exports.MAX_DEADLINE_DAYS = exports.MAX_DEADLINE_HOURS = exports.MIN_AMOUNT_WEI = exports.DEFAULT_DEADLINE_SECONDS = exports.DEFAULT_DISPUTE_WINDOW_SECONDS = exports.ValidationError = exports.BaseAdapter = void 0;
var BaseAdapter_1 = require("./BaseAdapter");
Object.defineProperty(exports, "BaseAdapter", { enumerable: true, get: function () { return BaseAdapter_1.BaseAdapter; } });
Object.defineProperty(exports, "ValidationError", { enumerable: true, get: function () { return BaseAdapter_1.ValidationError; } });
Object.defineProperty(exports, "DEFAULT_DISPUTE_WINDOW_SECONDS", { enumerable: true, get: function () { return BaseAdapter_1.DEFAULT_DISPUTE_WINDOW_SECONDS; } });
Object.defineProperty(exports, "DEFAULT_DEADLINE_SECONDS", { enumerable: true, get: function () { return BaseAdapter_1.DEFAULT_DEADLINE_SECONDS; } });
Object.defineProperty(exports, "MIN_AMOUNT_WEI", { enumerable: true, get: function () { return BaseAdapter_1.MIN_AMOUNT_WEI; } });
Object.defineProperty(exports, "MAX_DEADLINE_HOURS", { enumerable: true, get: function () { return BaseAdapter_1.MAX_DEADLINE_HOURS; } });
Object.defineProperty(exports, "MAX_DEADLINE_DAYS", { enumerable: true, get: function () { return BaseAdapter_1.MAX_DEADLINE_DAYS; } });
var BeginnerAdapter_1 = require("./BeginnerAdapter");
Object.defineProperty(exports, "BeginnerAdapter", { enumerable: true, get: function () { return BeginnerAdapter_1.BeginnerAdapter; } });
var IntermediateAdapter_1 = require("./IntermediateAdapter");
Object.defineProperty(exports, "IntermediateAdapter", { enumerable: true, get: function () { return IntermediateAdapter_1.IntermediateAdapter; } });
//# sourceMappingURL=index.js.map