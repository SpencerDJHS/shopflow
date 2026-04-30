// ----------------------------------------
// CHECKPOINT MARKING PAGE
// ----------------------------------------
pages.checkpoint = {
    selectedClass: null,
    selectedActivity: null,
    selectedTeam: null,
    selectedCheckpoint: null,
    teamMembers: [],
    activityFilter: 'active',

    render: async function() {
        this.reset();
        await this.renderClassButtons();
        await this.autoSelect();
    },

    renderClassButtons: async function() {
        const container = document.getElementById('checkpoint-class-buttons');
        if (!container) return;

        const classes = (await db.classes.toArray()).filter(c => c.status !== 'archived');
        container.innerHTML = '';

        classes.forEach(cls => {
            const btn = document.createElement('button');
            btn.className = 'btn btn--secondary checkpoint-year-btn';
            btn.dataset.classId = cls.id;
            btn.textContent = cls.name;
            btn.onclick = () => pages.checkpoint.selectClass(cls);
            container.appendChild(btn);
        });
    },

    autoSelect: async function() {
        await pages.dashboard.updateCurrentPeriod();

        if (!state.currentPeriod || state.currentPeriod === 'wildcat') return;

        try {
            // Find class that owns the current period
            const allClasses = (await db.classes.toArray()).filter(c => c.status !== 'archived');
            const matchingClass = allClasses.find(cls =>
                (cls.periods || []).includes(String(state.currentPeriod))
            );

            if (!matchingClass) return;

            await this.selectClass(matchingClass);

            // Auto-select active activity for this class
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const allActivities = await db.activities.toArray();
            const classActivities = allActivities.filter(a => a.classId === matchingClass.id);

            const activeActivity = classActivities.find(a => {
                const startParts = a.startDate.split('-');
                const endParts = a.endDate.split('-');
                const startDate = new Date(startParts[0], startParts[1] - 1, startParts[2]);
                const endDate = new Date(endParts[0], endParts[1] - 1, endParts[2]);
                return today >= startDate && today <= endDate;
            });

            if (activeActivity) {
                await this.selectActivity(activeActivity);
            }

        } catch (error) {
            console.error('Error auto-selecting:', error);
        }
    },

    reset: function() {
        this.selectedClass = null;
        this.selectedActivity = null;
        this.selectedTeam = null;
        this.selectedCheckpoint = null;
        this.teamMembers = [];

        document.getElementById('checkpoint-step-year').classList.remove('hidden');
        document.getElementById('checkpoint-step-activity').classList.add('hidden');
        document.getElementById('checkpoint-step-team').classList.add('hidden');
        document.getElementById('checkpoint-step-checkpoint').classList.add('hidden');
        document.getElementById('checkpoint-step-students').classList.add('hidden');

        document.querySelectorAll('.checkpoint-year-btn').forEach(btn => btn.classList.remove('active'));
    },

    selectClass: async function(cls) {
        this.selectedClass = cls;
        this.selectedActivity = null;
        this.selectedTeam = null;
        this.selectedCheckpoint = null;

        document.getElementById('checkpoint-step-team').classList.add('hidden');
        document.getElementById('checkpoint-step-checkpoint').classList.add('hidden');
        document.getElementById('checkpoint-step-students').classList.add('hidden');

        // Highlight selected button
        document.querySelectorAll('.checkpoint-year-btn').forEach(btn => {
            const isActive = parseInt(btn.dataset.classId) === cls.id;
            btn.classList.toggle('active', isActive);
        });

        // Load activities for this class
        try {
            const allActivities = await db.activities.toArray();
            const classActivities = allActivities.filter(a => a.classId === cls.id);

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            let filteredActivities = classActivities;

            if (this.activityFilter !== 'all') {
                filteredActivities = classActivities.filter(a => {
                    const startParts = a.startDate.split('-');
                    const endParts = a.endDate.split('-');
                    const startDate = new Date(startParts[0], startParts[1] - 1, startParts[2]);
                    const endDate = new Date(endParts[0], endParts[1] - 1, endParts[2]);

                    if (this.activityFilter === 'active') return today >= startDate && today <= endDate;
                    if (this.activityFilter === 'past') return today > endDate;
                    if (this.activityFilter === 'upcoming') return today < startDate;
                    return true;
                });
            }

            const container = document.getElementById('checkpoint-activities-list');
            container.innerHTML = '';

            if (filteredActivities.length === 0) {
                container.innerHTML = '<p style="color: var(--color-text-tertiary);">No assignments found for this class.</p>';
            } else {
                filteredActivities.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
                filteredActivities.forEach(activity => {
                    const btn = document.createElement('button');
                    btn.className = 'btn btn--secondary checkpoint-activity-btn';
                    btn.style.marginRight = 'var(--space-sm)';
                    btn.style.marginBottom = 'var(--space-sm)';
                    btn.textContent = activity.name;
                    btn.dataset.activityId = activity.id;
                    btn.onclick = () => pages.checkpoint.selectActivity(activity);
                    container.appendChild(btn);
                });
            }

            document.getElementById('checkpoint-step-activity').classList.remove('hidden');

        } catch (error) {
            console.error('Error loading activities:', error);
            ui.showToast('Failed to load activities', 'error');
        }
    },

    filterActivities: function(filter) {
        this.activityFilter = filter;

        document.querySelectorAll('.checkpoint-activity-filter').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === filter);
        });

        if (this.selectedClass) {
            this.selectClass(this.selectedClass);
        }
    },

    selectActivity: async function(activity) {
        this.selectedActivity = activity;
        this.selectedTeam = null;
        this.selectedCheckpoint = null;

        document.getElementById('checkpoint-step-checkpoint').classList.add('hidden');
        document.getElementById('checkpoint-step-students').classList.add('hidden');

        document.querySelectorAll('.checkpoint-activity-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.activityId == activity.id);
        });

        // Load teams for this class
        try {
            const allTeams = await db.teams.toArray();
            const teams = allTeams
                .filter(t => t.classId === this.selectedClass.id)
                .sort((a, b) => a.name.localeCompare(b.name));

            const container = document.getElementById('checkpoint-teams-list');
            container.innerHTML = '';

            if (teams.length === 0) {
                container.innerHTML = '<p style="color: var(--color-text-tertiary);">No groups found for this class.</p>';
            } else {
                teams.forEach(team => {
                    const btn = document.createElement('button');
                    btn.className = 'btn btn--secondary checkpoint-team-btn';
                    btn.style.marginRight = 'var(--space-sm)';
                    btn.style.marginBottom = 'var(--space-sm)';
                    btn.textContent = team.name;
                    btn.dataset.teamId = team.id;
                    btn.onclick = () => pages.checkpoint.selectTeam(team);
                    container.appendChild(btn);
                });
            }

            document.getElementById('checkpoint-step-team').classList.remove('hidden');

        } catch (error) {
            console.error('Error loading teams:', error);
            ui.showToast('Failed to load teams', 'error');
        }
    },

    selectTeam: async function(team) {
        this.selectedTeam = team;
        this.selectedCheckpoint = null;
        document.getElementById('checkpoint-step-students').classList.add('hidden');

        document.querySelectorAll('.checkpoint-team-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.teamId == team.id);
        });

        try {
            const teamMemberRecords = await db.teamMembers.where('teamId').equals(team.id).toArray();
            const allStudents = await db.students.toArray();
            this.teamMembers = allStudents
                .filter(s => teamMemberRecords.map(tm => tm.studentId).includes(s.id))
                .sort(sortByStudentName);

            const checkpoints = await db.checkpoints
                .where('activityId')
                .equals(this.selectedActivity.id)
                .toArray();
            checkpoints.sort((a, b) => a.number - b.number);

            const container = document.getElementById('checkpoint-checkpoints-list');
            container.innerHTML = '';

            if (checkpoints.length === 0) {
                container.innerHTML = '<p style="color: var(--color-text-tertiary);">No checkpoints for this assignment.</p>';
            } else {
                checkpoints.forEach(cp => {
                    const btn = document.createElement('button');
                    btn.className = 'btn btn--secondary checkpoint-checkpoint-btn';
                    btn.style.marginRight = 'var(--space-sm)';
                    btn.style.marginBottom = 'var(--space-sm)';
                    btn.textContent = `${cp.number}. ${cp.title}`;
                    btn.dataset.checkpointId = cp.id;
                    btn.onclick = () => pages.checkpoint.selectCheckpoint(cp);
                    container.appendChild(btn);
                });
            }

            document.getElementById('checkpoint-step-checkpoint').classList.remove('hidden');

        } catch (error) {
            console.error('Error loading checkpoints:', error);
            ui.showToast('Failed to load checkpoints', 'error');
        }
    },

    selectCheckpoint: async function(checkpoint) {
        this.selectedCheckpoint = checkpoint;

        document.querySelectorAll('.checkpoint-checkpoint-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.checkpointId == checkpoint.id);
        });

        document.getElementById('checkpoint-current-title').textContent =
            `${this.selectedTeam.name} — ${this.selectedActivity.name} — Checkpoint ${checkpoint.number}: ${checkpoint.title}`;

        const questionsDiv = document.getElementById('checkpoint-questions');
        if (checkpoint.questions && (Array.isArray(checkpoint.questions) ? checkpoint.questions.length > 0 : checkpoint.questions.trim())) {
            if (Array.isArray(checkpoint.questions)) {
                let qaHtml = `<table style="width: 100%; border-collapse: collapse; font-size: var(--font-size-body-small);">
                    <thead><tr>
                        <th style="text-align: left; padding: var(--space-xs) var(--space-sm); border-bottom: 2px solid var(--color-border); width: 40px;"></th>
                        <th style="text-align: left; padding: var(--space-xs) var(--space-sm); border-bottom: 2px solid var(--color-border);">Teacher Asks / Checks</th>
                        <th style="text-align: left; padding: var(--space-xs) var(--space-sm); border-bottom: 2px solid var(--color-border);">Student Should Answer / Demo</th>
                    </tr></thead><tbody>`;
                checkpoint.questions.forEach((qa, i) => {
                    qaHtml += `<tr>
                        <td style="padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--color-border); vertical-align: top;">
                            <input type="checkbox" style="cursor: pointer;" title="Visual reference only">
                        </td>
                        <td style="padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--color-border); vertical-align: top;">${escapeHtml(qa.question || '')}</td>
                        <td style="padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--color-border); vertical-align: top; color: var(--color-text-secondary);">${escapeHtml(qa.expectedResponse || '')}</td>
                    </tr>`;
                });
                qaHtml += '</tbody></table>';
                questionsDiv.innerHTML = qaHtml;
            } else {
                // Legacy: plain text questions
                questionsDiv.innerHTML = `<strong>Questions/Criteria:</strong><p style="margin-top: var(--space-xs);">${escapeHtml(checkpoint.questions)}</p>`;
            }
        } else {
            questionsDiv.innerHTML = '';
        }

        try {
            const existingCompletions = await db.checkpointCompletions
                .where('checkpointId')
                .equals(checkpoint.id)
                .toArray();

            const completedStudentIds = existingCompletions
                .filter(c => c.completed)
                .map(c => c.studentId);

            const container = document.getElementById('checkpoint-students-list');
            container.innerHTML = '';

            this.teamMembers.forEach(student => {
                const isComplete = completedStudentIds.includes(student.id);
                const item = document.createElement('div');
                item.className = `checkpoint__student-item ${isComplete ? 'checkpoint__student-item--complete' : ''}`;
                item.id = `checkpoint-student-${student.id}`;

                item.innerHTML = `
                    <input type="checkbox"
                        id="check-${student.id}"
                        ${isComplete ? 'checked' : ''}
                        onchange="pages.checkpoint.toggleStudent(${student.id}, this.checked)">
                    <label for="check-${student.id}" style="cursor: pointer; flex: 1;">
                        ${escapeHtml(displayName(student))}
                    </label>
                    ${isComplete ? '<span class="badge badge--success">Complete</span>' : '<span class="badge badge--warning">Pending</span>'}
                `;

                // Attach swipe gestures (touch only — PC skips)
                gestures.makeSwipeable(item, {
                    onSwipeRight: () => {
                        const cb = document.getElementById(`check-${student.id}`);
                        if (cb && !cb.checked) {
                            cb.checked = true;
                            pages.checkpoint.toggleStudent(student.id, true);
                        }
                    },
                    onSwipeLeft: () => {
                        const cb = document.getElementById(`check-${student.id}`);
                        if (cb && cb.checked) {
                            cb.checked = false;
                            pages.checkpoint.toggleStudent(student.id, false);
                        }
                    },
                    rightColor: 'var(--color-success)',
                    leftColor: 'var(--color-warning)',
                    rightIcon: '✓',
                    leftIcon: '↩',
                    ignoreSelector: 'input[type="checkbox"]'
                });

                container.appendChild(item);
            });

            document.getElementById('checkpoint-step-students').classList.remove('hidden');

        } catch (error) {
            console.error('Error loading completions:', error);
            ui.showToast('Failed to load student progress', 'error');
        }
    },

    toggleStudent: function(studentId, isChecked) {
        const item = document.getElementById(`checkpoint-student-${studentId}`);
        if (isChecked) {
            item.classList.add('checkpoint__student-item--complete');
            item.querySelector('.badge').className = 'badge badge--success';
            item.querySelector('.badge').textContent = 'Complete';
        } else {
            item.classList.remove('checkpoint__student-item--complete');
            item.querySelector('.badge').className = 'badge badge--warning';
            item.querySelector('.badge').textContent = 'Pending';
        }
    },

    markAllComplete: function() {
        this.teamMembers.forEach(student => {
            const checkbox = document.getElementById(`check-${student.id}`);
            if (checkbox && !checkbox.checked) {
                checkbox.checked = true;
                this.toggleStudent(student.id, true);
            }
        });
    },

    saveProgress: async function() {
        try {
            const checkpointId = this.selectedCheckpoint.id;

            for (const student of this.teamMembers) {
                const checkbox = document.getElementById(`check-${student.id}`);
                const isComplete = checkbox ? checkbox.checked : false;

                const existing = await db.checkpointCompletions
                    .where('[checkpointId+studentId]')
                    .equals([checkpointId, student.id])
                    .first();

                if (existing) {
                    await db.checkpointCompletions.update(existing.id, {
                        completed: isComplete,
                        completedAt: isComplete ? new Date().toISOString() : null,
                        updatedAt: new Date().toISOString()
                    });
                } else {
                    await db.checkpointCompletions.add({
                        checkpointId: checkpointId,
                        studentId: student.id,
                        completed: isComplete,
                        completedAt: isComplete ? new Date().toISOString() : null,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    });
                }
            }

            ui.showToast('Progress saved successfully!', 'success');

            // Refresh the live alerts board (alerts auto-clear when conditions resolve)
            alertsEngine.refresh().then(() => {
                if (typeof pages !== 'undefined' && pages.dashboard && pages.dashboard.loadAlerts) {
                    pages.dashboard.loadAlerts();
                }
            });

        } catch (error) {
            console.error('Error saving progress:', error);
            ui.showToast('Failed to save progress', 'error');
        }
    }
};