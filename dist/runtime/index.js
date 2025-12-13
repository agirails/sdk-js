"use strict";
/**
 * Runtime module exports.
 *
 * Provides both the runtime interface and concrete implementations.
 *
 * @module runtime
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisputeWindowActiveError = exports.InvalidAmountError = exports.ContractPausedError = exports.DeadlinePassedError = exports.EscrowNotFoundError = exports.InsufficientBalanceError = exports.InvalidStateTransitionError = exports.TransactionNotFoundError = exports.BlockchainRuntime = exports.MockStateManager = exports.MockRuntime = void 0;
var MockRuntime_1 = require("./MockRuntime");
Object.defineProperty(exports, "MockRuntime", { enumerable: true, get: function () { return MockRuntime_1.MockRuntime; } });
var MockStateManager_1 = require("./MockStateManager");
Object.defineProperty(exports, "MockStateManager", { enumerable: true, get: function () { return MockStateManager_1.MockStateManager; } });
var BlockchainRuntime_1 = require("./BlockchainRuntime");
Object.defineProperty(exports, "BlockchainRuntime", { enumerable: true, get: function () { return BlockchainRuntime_1.BlockchainRuntime; } });
__exportStar(require("./types/MockState"), exports);
// Re-export all custom errors from MockRuntime
var MockRuntime_2 = require("./MockRuntime");
Object.defineProperty(exports, "TransactionNotFoundError", { enumerable: true, get: function () { return MockRuntime_2.TransactionNotFoundError; } });
Object.defineProperty(exports, "InvalidStateTransitionError", { enumerable: true, get: function () { return MockRuntime_2.InvalidStateTransitionError; } });
Object.defineProperty(exports, "InsufficientBalanceError", { enumerable: true, get: function () { return MockRuntime_2.InsufficientBalanceError; } });
Object.defineProperty(exports, "EscrowNotFoundError", { enumerable: true, get: function () { return MockRuntime_2.EscrowNotFoundError; } });
Object.defineProperty(exports, "DeadlinePassedError", { enumerable: true, get: function () { return MockRuntime_2.DeadlinePassedError; } });
Object.defineProperty(exports, "ContractPausedError", { enumerable: true, get: function () { return MockRuntime_2.ContractPausedError; } });
Object.defineProperty(exports, "InvalidAmountError", { enumerable: true, get: function () { return MockRuntime_2.InvalidAmountError; } });
Object.defineProperty(exports, "DisputeWindowActiveError", { enumerable: true, get: function () { return MockRuntime_2.DisputeWindowActiveError; } });
//# sourceMappingURL=index.js.map