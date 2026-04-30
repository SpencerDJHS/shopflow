// ============================================
// CONSTANTS
// ============================================

const QUICK_ACTION_REGISTRY = [
    { id: 'take-attendance', label: 'Take Attendance', btnClass: 'btn--primary', style: '', onclick: "router.navigate('attendance')" },
    { id: 'end-class', label: 'End Class', btnClass: 'btn--primary', style: 'background-color: var(--color-warning);', onclick: 'modals.showEndClass()' },
    { id: 'mark-checkpoints', label: 'Checkpoints', btnClass: 'btn--secondary', style: '', onclick: "state.updateCurrentPage('checkpoint')" },
    { id: 'check-inventory', label: 'Inventory', btnClass: 'btn--secondary', style: '', onclick: "router.navigate('inventory')" },
    { id: 'add-task', label: 'Add Task', btnClass: 'btn--secondary', style: '', onclick: 'modals.showAddTask()' },
    { id: 'check-all-submissions', label: 'Check Submissions', btnClass: 'btn--secondary', style: '', onclick: 'pages.dashboard.checkAllFormSubmissions(this)' }
];

// ============================================
// CHART HELPERS (Sprint 14.0)
// ============================================

const CHART_COLORS = {
    // Okabe-Ito colorblind-safe palette
    R: '#E69F00',  // Orange
    A: '#56B4E9',  // Sky blue
    C: '#009E73',  // Teal/green
    E: '#CC79A7',  // Pink/magenta
    // General-purpose series colors
    series: ['#E69F00', '#56B4E9', '#009E73', '#CC79A7', '#F0E442', '#0072B2', '#D55E00']
};

const CHART_STROKES = {
    // Distinct stroke patterns for grayscale print readability
    R: '',           // solid
    A: '8,4',        // dashed
    C: '2,4',        // dotted
    E: '8,4,2,4',    // dash-dot
    series: ['', '8,4', '2,4', '8,4,2,4', '4,4', '12,4', '2,2']
};
