// ============================================
// STATE MANAGEMENT
// ============================================

const state = {
    currentPage: 'dashboard',
    currentPeriod: null,
    selectedStudent: null,
    selectedTeam: null,
    selectedActivity: null,
    editingStudentId: null,
    flexPeriodName: 'Wildcat',

    updateCurrentPage: function(page) {
        this.currentPage = page;
        router.navigate(page);
    },

    setPeriod: function(period) {
        this.currentPeriod = period;
    }
};

var pages = {};
