// ============================================
// AUTO-BACKUP SYSTEM
// Saves a snapshot at noon and 4pm each day.
// Keeps 14 snapshots (2 per day for 7 days).
// ============================================
const autoBackup = {
    MAX_BACKUPS: 14,

    // Take a snapshot of all data and save to backupDb
    async save(slot) {
        try {
            const data = {};
            for (const table of db.tables) {
                data[table.name] = await table.toArray();
            }
            data.exportDate = new Date().toISOString();

            const label = `${new Date().toLocaleDateString('en-US', { 
                weekday: 'short', month: 'short', day: 'numeric' 
            })} — ${slot === 'noon' ? '12:00 PM' : '4:00 PM'}`;

            await backupDb.backups.add({
                createdAt: new Date().toISOString(),
                label: label,
                slot: slot,
                data: JSON.stringify(data)
            });

            // Trim to MAX_BACKUPS — delete oldest first
            const all = await backupDb.backups.orderBy('createdAt').toArray();
            if (all.length > this.MAX_BACKUPS) {
                const toDelete = all.slice(0, all.length - this.MAX_BACKUPS);
                for (const backup of toDelete) {
                    await backupDb.backups.delete(backup.id);
                }
            }

            console.log(`✅ Auto-backup saved: ${label}`);
            return true;
        } catch (err) {
            console.error('Auto-backup failed:', err);
            return false;
        }
    },

    // Check if a backup for today's slot already exists
    async alreadyRanToday(slot) {
        const today = getTodayString();
        const all = await backupDb.backups.toArray();
        return all.some(b => b.slot === slot && b.createdAt.startsWith(today));
    },

    // Run on app open — check if noon or 4pm backup is due
    async runIfDue() {
        const now = new Date();
        const hour = now.getHours();

        // Noon slot: run if it's 12pm or later and hasn't run today
        if (hour >= 12 && !(await this.alreadyRanToday('noon'))) {
            await this.save('noon');
        }

        // 4pm slot: run if it's 4pm or later and hasn't run today
        if (hour >= 16 && !(await this.alreadyRanToday('4pm'))) {
            await this.save('4pm');
        }
    },

    // Restore a specific backup by ID
    async restore(backupId) {
        try {
            const backup = await backupDb.backups.get(backupId);
            if (!backup || !backup.data) {
                ui.showToast('Backup not found.', 'error');
                return;
            }

            // Save current state as a safety snapshot before overwriting anything
            const safetyData = {};
            for (const table of db.tables) {
                safetyData[table.name] = await table.toArray();
            }
            safetyData.exportDate = new Date().toISOString();

            const safetyLabel = `Before restore — ${new Date().toLocaleString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit'
            })}`;

            await backupDb.backups.add({
                createdAt: new Date().toISOString(),
                label: safetyLabel,
                slot: 'safety',
                data: JSON.stringify(safetyData)
            });

            // Trim to MAX_BACKUPS after adding safety snapshot
            const all = await backupDb.backups.orderBy('createdAt').toArray();
            if (all.length > this.MAX_BACKUPS) {
                const toDelete = all.slice(0, all.length - this.MAX_BACKUPS);
                for (const b of toDelete) {
                    await backupDb.backups.delete(b.id);
                }
            }

            // Now restore the selected snapshot
            const data = JSON.parse(backup.data);

            await db.transaction('rw', db.tables, async () => {
                for (const table of db.tables) {
                    await table.clear();
                    if (data[table.name] && Array.isArray(data[table.name])) {
                        await table.bulkAdd(data[table.name]);
                    }
                }
            });

            ui.showToast(`Restored to: ${backup.label}. Reloading...`, 'success');
            setTimeout(() => window.location.reload(), 1200);
        } catch (err) {
            console.error('Restore failed:', err);
            ui.showToast('Restore failed — backup may be corrupted.', 'error');
        }
    },

    // Render the backup list into a container element
    async renderList(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const all = await backupDb.backups.orderBy('createdAt').reverse().toArray();

        if (all.length === 0) {
            container.innerHTML = '<p style="color: var(--color-text-tertiary); font-style: italic;">No auto-backups yet. Open the app at noon or after 4pm to generate one.</p>';
            return;
        }

        container.innerHTML = '';
        all.forEach(backup => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: var(--space-sm); border: 1px solid var(--color-border); border-radius: var(--radius-md); margin-bottom: var(--space-xs);';
            row.innerHTML = `
                <div>
                    <span style="font-weight: 500;">${escapeHtml(backup.label)}</span>
                </div>
                <button class="btn btn--secondary" style="font-size: var(--font-size-body-small); padding: var(--space-xs) var(--space-sm);"
                    onclick="autoBackup.confirmRestore(${backup.id})">
                    Restore
                </button>
            `;
            container.appendChild(row);
        });
    },

    // Confirm before restoring
    async confirmRestore(backupId) {
        const backup = await backupDb.backups.get(backupId);
        if (!backup) {
            ui.showToast('Backup not found.', 'error');
            return;
        }

        const confirmed = confirm(
            `⚠️ Restore to: "${backup.label}"?\n\n` +
            `This will REPLACE all current data with that snapshot.\n` +
            `Any changes made after that snapshot will be lost.\n\n` +
            `Your current data will be saved as a safety snapshot first, ` +
            `so you can undo this if needed.\n\n` +
            `Click OK to proceed.`
        );

        if (confirmed) {
            this.restore(backupId);
        }
    }
};