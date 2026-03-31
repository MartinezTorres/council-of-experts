import { randomBytes } from 'crypto';
/**
 * Generate a unique ID for messages, turns, etc.
 */
export function generateId() {
    return randomBytes(16).toString('hex');
}
/**
 * Normalize timestamp to ISO string
 */
export function normalizeTimestamp(timestamp) {
    if (!timestamp) {
        return new Date().toISOString();
    }
    if (typeof timestamp === 'string') {
        return timestamp;
    }
    if (typeof timestamp === 'number') {
        return new Date(timestamp).toISOString();
    }
    if (timestamp instanceof Date) {
        return timestamp.toISOString();
    }
    return new Date().toISOString();
}
//# sourceMappingURL=utils.js.map