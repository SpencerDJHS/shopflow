// ============================================
// EXPORT REMINDER
// Warns the user if 7 days have passed
// since their last manual export.
// ============================================
const exportReminder = {
    DAYS_THRESHOLD: 7,

    async recordExport() {
        const now = new Date().toISOString();
        localStorage.setItem('last-manual-export', now);
        await db.settings.put({ key: 'last-manual-export', value: now });
        driveSync.markDirty();
    },

    async check() {
        const thresholdSetting = await db.settings.get('backup-reminder-days');
        const threshold = thresholdSetting ? Number(thresholdSetting.value) : this.DAYS_THRESHOLD;
        if (threshold === 0) return;

        const dbSetting = await db.settings.get('last-manual-export');
        const lastExport = dbSetting ? dbSetting.value : localStorage.getItem('last-manual-export');

        if (!lastExport) {
            setTimeout(() => this.showReminder(true, threshold), 3000);
            return;
        }

        const daysSince = (Date.now() - new Date(lastExport).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince >= threshold) {
            setTimeout(() => this.showReminder(false, threshold), 3000);
        }
    },

    showReminder(isFirstTime, threshold) {
        const message = isFirstTime
            ? '💾 You haven\'t exported a backup yet. Export your data regularly to protect against data loss — browser cache clears will permanently delete everything.'
            : `💾 It's been over ${threshold || 7} days since your last export. Consider exporting a backup now.`;
        ui.showToast(message, 'warning', 8000);
    }
};

// Sprint 13.4: Migrate last-manual-export from localStorage to db.settings
async function migrateLastExportTimestamp() {
    const existing = await db.settings.get('last-manual-export');
    if (!existing) {
        const lsValue = localStorage.getItem('last-manual-export');
        if (lsValue) {
            await db.settings.put({ key: 'last-manual-export', value: lsValue });
        }
    }
}

// ============================================
// EXPORT MANAGER — FERPA-safe export routing
// ============================================
const exportManager = {
    _pendingExport: null,

    /**
     * Shows the FERPA choice modal and queues an export function.
     * @param {Function} exportFn - Receives a boolean `ferpa` parameter.
     */
    prompt: function(exportFn) {
        this._pendingExport = exportFn;
        ui.showModal('modal-export-options');
    },

    /**
     * Called by the modal buttons. Runs the queued export.
     * @param {boolean} ferpa - true = strip PII, false = include names/emails.
     */
    execute: function(ferpa) {
        ui.hideModal('modal-export-options');
        if (this._pendingExport) {
            this._pendingExport(ferpa);
            this._pendingExport = null;
        }
    }
};