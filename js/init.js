// Helper to switch to detail view and pass the ID
function viewStudent(id) {
    router.navigate('student-detail');
    pages.studentDetail.render(id);
}

document.addEventListener('DOMContentLoaded', async () => {

    // ============================================
    // EVENT LISTENERS
    // ============================================

    // Navigation clicks
    document.querySelectorAll('.sidebar__nav-item a').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const page = e.target.closest('a').dataset.page;
            state.updateCurrentPage(page);
            closeSidebar();
        });
    });

    // Sidebar toggle (mobile)
    document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        sidebar.classList.toggle('sidebar--open');
        overlay.classList.toggle('sidebar-overlay--visible');
    });

    window.closeSidebar = function() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        sidebar.classList.remove('sidebar--open');
        overlay.classList.remove('sidebar-overlay--visible');
    };

    // Global search
    document.getElementById('global-search')?.addEventListener('input', (e) => {
        globalSearch.run(e.target.value);
    });

    document.getElementById('global-search')?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') globalSearch.close();
    });

    // Quick action buttons
    document.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const action = e.target.dataset.action;
            switch(action) {
                case 'take-attendance':
                    router.navigate('attendance');
                    break;
                case 'mark-checkpoints':
                    state.updateCurrentPage('checkpoint');
                    break;
                case 'add-note':
                    ui.showModal('modal-note');
                    break;
                case 'check-inventory':
                    router.navigate('inventory');
                    break;
                case 'end-class':
                    modals.showEndClass();
                    break;
                case 'check-all-submissions':
                    pages.dashboard.checkAllFormSubmissions(e.target);
                    break;
                default:
                    console.log('Action not yet implemented:', action);
            }
        });
    });

    // Modal close buttons
    document.querySelectorAll('.modal__close').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal-backdrop');
            ui.hideModal(modal.id);
        });
    });

    // Activity filter buttons
    document.querySelectorAll('.activity-filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const filter = e.target.dataset.filter;
            pages.activities.setFilter(filter);
        });
    });

    // ============================================
    // APP START
    // ============================================

    await initializePeriodYearMap();
    await migrateLastExportTimestamp();
    await requestStoragePersistence();
    await autoBackup.runIfDue();
    await pinLock.init();
    await exportReminder.check();
    driveSyncPull.checkOnLoad();
    router.navigate('dashboard');

    getActiveSchoolYear().then(year => {
        const el = document.getElementById('header-school-year');
        if (el) el.textContent = `📅 ${year}`;
    });
});