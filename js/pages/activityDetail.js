// ----------------------------------------
// ACTIVITY DETAIL PAGE
// ----------------------------------------
pages.activityDetail = {
    open: function(activityId) {
        state.selectedActivity = activityId;
        router.navigate('activity-detail');
    },
    
    render: async function() {
        const activityId = state.selectedActivity;
        if (!activityId) {
            router.navigate('activities');
            return;
        }
        
        try {
            // Load activity
            const activity = await db.activities.get(activityId);
            if (!activity) {
                ui.showToast('Activity not found', 'error');
                router.navigate('activities');
                return;
            }
            
            // Load checkpoints
            const checkpoints = await db.checkpoints
                .where('activityId')
                .equals(activityId)
                .toArray();
            checkpoints.sort((a, b) => a.number - b.number);
            
            // Load teams for this class
            const allTeams = excludeDeleted(await db.teams.toArray());
            const teams = allTeams.filter(t => t.classId === activity.classId);

            // Load all students in this class
            const periodMap = await db.settings.get('period-year-map');
            const classPeriodsMap = periodMap?.value || {};
            const periodsForClass = Object.entries(classPeriodsMap)
                .filter(([period, classId]) => parseInt(classId) === activity.classId)
                .map(([period]) => period);

            const activeYear = await getActiveSchoolYear();
            const allEnrollments = await db.enrollments.toArray();
            const enrolledStudentIds = new Set(
                allEnrollments
                    .filter(e => periodsForClass.includes(String(e.period)) && (!e.schoolYear || e.schoolYear === activeYear))
                    .map(e => e.studentId)
            );

            const allStudents = excludeDeleted(await db.students.toArray())
                .filter(s => (s.status || 'active') === 'active' && (s.classId === activity.classId || enrolledStudentIds.has(s.id)))
                .sort(sortByStudentName);
            
            // Load all checkpoint completions
            const allCompletions = await db.checkpointCompletions.toArray();
            const checkpointIds = checkpoints.map(cp => cp.id);
            const relevantCompletions = allCompletions.filter(c => 
                checkpointIds.includes(c.checkpointId)
            );

            // Load team members
            const allTeamMembers = await db.teamMembers.toArray();
            
            // Store data for tab rendering
            this._data = { activity, checkpoints, teams, allStudents, relevantCompletions, allTeamMembers };

            // Set title
            document.getElementById('activity-detail-title').textContent = activity.name;

            // Show/hide Check Form Submissions button based on formSpreadsheetId
            const checkFormBtn = document.getElementById('check-form-submissions-btn');
            if (checkFormBtn) {
                checkFormBtn.style.display = activity.formSpreadsheetId ? '' : 'none';
            }

            // Check if we should jump to a specific tab (e.g., from a grading auto-task)
            const initialTab = state.activityDetailInitialTab || 'overview';
            delete state.activityDetailInitialTab;
            this.setTab(initialTab);

            // Also highlight the correct tab button if not overview
            if (initialTab !== 'overview') {
                const tabButtons = document.querySelectorAll('#page-activity-detail .tab-btn');
                tabButtons.forEach(btn => {
                    btn.classList.remove('active');
                    if (btn.textContent.toLowerCase().includes(initialTab)) {
                        btn.classList.add('active');
                    }
                });
            }
            
            // Hook up Notes
            notesManager.loadNotes('activity', activity.id, 'notes-list-activity');
            const saveBtn = document.getElementById('save-note-btn-activity');
            if (saveBtn) {
                saveBtn.onclick = () => notesManager.addNote('activity', activity.id, 'note-input-activity');
            }
            
        } catch (error) {
            console.error('Error loading activity detail:', error);
            ui.showToast('Failed to load activity details', 'error');
        }
    },

    deduplicateFormSubmissions: function(submissions) {
        // Group by cleaned email, keeping highest-scoring submission per student
        const byEmail = new Map();
        
        for (const sub of submissions) {
            // Strip (1), (2), etc. suffix from email
            let email = (sub.email || '').toLowerCase().trim();
            email = email.replace(/\(\d+\)$/, '').trim();
            if (!email) continue;
            
            // Calculate total score for this submission
            const totalScore = (sub.answers || []).reduce((sum, a) => sum + (a.score || 0), 0);
            
            const existing = byEmail.get(email);
            if (!existing || totalScore > existing._totalScore) {
                byEmail.set(email, { ...sub, email: email, _totalScore: totalScore });
            }
        }
        
        return [...byEmail.values()];
    },

    checkFormSubmissions: async function() {
        const activity = await db.activities.get(state.selectedActivity);
        if (!activity || !activity.formSpreadsheetId) {
            ui.showToast('No form spreadsheet linked to this assignment', 'error');
            return;
        }

        const automationsEnabled = localStorage.getItem('automations-enabled') === 'true';
        const webhookUrl = localStorage.getItem('webhook_absent') || localStorage.getItem('webhook_wildcat');
        if (!automationsEnabled || !webhookUrl) {
            ui.showToast('Email automations must be enabled in Settings', 'error');
            return;
        }

        try {
            ui.showToast('Checking form submissions...', 'info');

            // Extract Form ID from formUrl if available
            // Google Form URLs look like: https://docs.google.com/forms/d/FORM_ID/edit
            let formId = null;
            if (activity.formUrl) {
                const match = activity.formUrl.match(/\/forms\/d\/([a-zA-Z0-9_-]+)/);
                if (match) formId = match[1];
            }

            const payload = {
                action: 'check_form_submissions',
                spreadsheetId: activity.formSpreadsheetId,
                token: localStorage.getItem('webhook_token') || ''
            };
            if (formId) payload.formId = formId;

            const response = await fetch(webhookUrl, {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            if (result.status !== 'success') throw new Error(result.message || 'Unknown error');

            // Match emails to ENROLLED students only (not last year's students)
            const periodMap = await db.settings.get('period-year-map');
            const classPeriodsMap = periodMap?.value || {};
            const periodsForClass = Object.entries(classPeriodsMap)
                .filter(([period, classId]) => parseInt(classId) === activity.classId)
                .map(([period]) => period);
            const activeYear = await getActiveSchoolYear();
            const allEnrollments = await db.enrollments.toArray();
            const enrolledStudentIds = new Set(
                allEnrollments
                    .filter(e => periodsForClass.includes(String(e.period)) && (!e.schoolYear || e.schoolYear === activeYear))
                    .map(e => e.studentId)
            );
            const allStudents = excludeDeleted(await db.students.toArray());
            const emailToStudent = new Map(
                allStudents
                    .filter(s => s.email && enrolledStudentIds.has(s.id))
                    .map(s => [s.email.toLowerCase().trim(), s])
            );

            let matched = 0;
            let unmatched = 0;
            const dedupedSubmissions = this.deduplicateFormSubmissions(result.submissions);
            for (const sub of dedupedSubmissions) {
                const email = sub.email;
                if (!email) continue;

                const student = emailToStudent.get(email);
                if (!student) { unmatched++; continue; }

                // Find existing submission
                const existing = await db.submissions
                    .where('activityId').equals(activity.id)
                    .filter(s => s.studentId === student.id)
                    .first();

                // Build formResponses object from the enriched data
                const formResponses = {
                    answers: (sub.answers || []).map(a => ({
                        question: a.question,
                        answer: a.answer,
                        score: a.score != null ? a.score : null,
                        maxPoints: a.maxPoints != null ? a.maxPoints : null,
                        autoFeedback: a.autoFeedback || null
                    })),
                    totalScore: sub.totalScore != null ? sub.totalScore : null,
                    totalPossible: sub.totalPossible != null ? sub.totalPossible : null,
                    autoFeedback: sub.autoFeedback || null,
                    importedAt: new Date().toISOString()
                };

                // Build auto-feedback from form response feedback (RACE parsing)
                let autoFeedbackParts = [];
                let raceScores = [];
                if (formResponses.answers && formResponses.answers.length > 0) {
                    let questionNum = 0;
                    for (const ans of formResponses.answers) {
                        if (ans.autoFeedback) {
                            questionNum++;
                            const parsed = this.parseRaceFeedback(ans.autoFeedback);
                            if (parsed) {
                                // Build readable summary for this question
                                let summary = `Q${questionNum} — ${ans.question || 'Extended Response'}:\n`;
                                summary += `  R: ${parsed.R ?? '—'}/5`;
                                if (parsed.comments.R) summary += ` — ${parsed.comments.R}`;
                                summary += `\n  A: ${parsed.A ?? '—'}/5`;
                                if (parsed.comments.A) summary += ` — ${parsed.comments.A}`;
                                summary += `\n  C: ${parsed.C ?? '—'}/5`;
                                if (parsed.comments.C) summary += ` — ${parsed.comments.C}`;
                                summary += `\n  E: ${parsed.E ?? '—'}/5`;
                                if (parsed.comments.E) summary += ` — ${parsed.comments.E}`;
                                summary += `\n  Total: ${parsed.total}/${parsed.maxTotal}`;
                                if (parsed.feedbackText) summary += `\n  ${parsed.feedbackText}`;
                                autoFeedbackParts.push(summary);
                                raceScores.push({ question: questionNum, ...parsed });
                            } else {
                                // Non-RACE feedback — include it as-is
                                autoFeedbackParts.push(`Q${questionNum} — ${ans.question || 'Question'}:\n  ${ans.autoFeedback}`);
                            }
                        }
                    }
                }

                // Combine form feedback with any existing custom feedback
                let combinedFeedback = null;
                if (autoFeedbackParts.length > 0) {
                    const formFeedbackText = autoFeedbackParts.join('\n\n');
                    if (existing?.feedback && existing.feedback.trim() !== '') {
                        // Check if the existing feedback already starts with form feedback
                        // (avoid duplicating on re-import)
                        if (!existing.feedback.startsWith('Q1 —') && !existing.feedback.startsWith('Q1 —')) {
                            combinedFeedback = formFeedbackText + '\n\n---\n\n' + existing.feedback;
                        } else {
                            // Re-import: replace the form portion, keep any text after the separator
                            const separatorIdx = existing.feedback.indexOf('\n\n---\n\n');
                            if (separatorIdx >= 0) {
                                combinedFeedback = formFeedbackText + existing.feedback.substring(separatorIdx);
                            } else {
                                combinedFeedback = formFeedbackText;
                            }
                        }
                    } else {
                        combinedFeedback = formFeedbackText;
                    }
                }

                if (existing) {
                    // Always update formResponses; only upgrade status (never downgrade)
                    const updates = {
                        formResponses: formResponses,
                        updatedAt: new Date().toISOString()
                    };
                    if (combinedFeedback !== null) updates.feedback = combinedFeedback;
                    if (raceScores.length > 0) updates.raceScores = raceScores;
                    if (['not-started', 'in-progress'].includes(existing.status)) {
                        updates.status = 'submitted';
                        updates.submittedAt = sub.timestamp || new Date().toISOString();
                    }
                    await db.submissions.update(existing.id, updates);
                    matched++;
                } else {
                    // Create new submission with formResponses
                    const newSub = {
                        activityId: activity.id,
                        studentId: student.id,
                        status: 'submitted',
                        formResponses: formResponses,
                        submittedAt: sub.timestamp || new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };
                    if (combinedFeedback !== null) newSub.feedback = combinedFeedback;
                    if (raceScores.length > 0) newSub.raceScores = raceScores;
                    await db.submissions.add(newSub);
                    matched++;
                }
            }

            let msg = `✅ Updated ${matched} submission(s) from form responses`;
            if (unmatched > 0) msg += ` (${unmatched} unmatched emails)`;
            ui.showToast(msg, matched > 0 ? 'success' : 'info', 5000);

            // Auto-map form scores to rubric if applicable
            const rubricMapped = await this.autoMapFormScoresToRubric(activity.id);
            if (rubricMapped > 0) msg += ` | ${rubricMapped} rubric(s) auto-scored`;
            // Refresh the page
            this.render(state.selectedActivity);

        } catch (err) {
            console.error('Form submission check failed:', err);
            ui.showToast('Failed to check form submissions — see console', 'error');
        }
    },

    _data: null,

    setTab: function(tabId, btn) {
        ['overview', 'teams', 'students', 'grading'].forEach(t => {
            const el = document.getElementById(`ad-tab-${t}`);
            if (el) el.classList.toggle('hidden', t !== tabId);
        });

        if (btn) {
            const tabButtons = btn.parentElement.querySelectorAll('.tab-btn');
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }

        if (!this._data) return;
        const { activity, checkpoints, teams, allStudents, relevantCompletions, allTeamMembers } = this._data;

        if (tabId === 'overview') this.renderOverview(activity, checkpoints, teams, allStudents, relevantCompletions, allTeamMembers);
        if (tabId === 'teams') this.renderTeamTab(teams, checkpoints, relevantCompletions, allTeamMembers, allStudents);
        if (tabId === 'students') this.renderStudentTab(allStudents, checkpoints, relevantCompletions, allTeamMembers, teams);
        if (tabId === 'grading') this.renderSubmissions(activity, allStudents);
    },

    renderOverview: async function(activity, checkpoints, teams, students, completions, teamMembers) {
        // --- Info Card ---
        const info = document.getElementById('activity-detail-info');
        document.getElementById('activity-pipeline-status').innerHTML = '';
        let className = 'Unknown Class';
        if (activity.classId) {
            const cls = await db.classes.get(activity.classId);
            if (cls) className = cls.name;
        }
        const startDate = new Date(activity.startDate + 'T00:00:00');
        const endDate = new Date(activity.endDate + 'T00:00:00');
        const formattedStart = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const formattedEnd = endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const scoringLabels = { 'rubric': 'Rubric', 'points': 'Points', 'complete-incomplete': 'Complete/Incomplete' };

        info.innerHTML = `<div class="card__body" style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-sm);">
            <p><strong>Class:</strong> ${escapeHtml(className)}</p>
            <p><strong>Scoring:</strong> ${scoringLabels[activity.scoringType] || 'N/A'}</p>
            <p><strong>Start:</strong> ${escapeHtml(formattedStart)}</p>
            <p><strong>End:</strong> ${escapeHtml(formattedEnd)}</p>
            <p><strong>Checkpoints:</strong> ${checkpoints.length}</p>
            <p><strong>Students:</strong> ${students.length}</p>
            ${activity.description ? `<p style="grid-column: 1 / -1; margin-top: var(--space-xs);"><strong>Description:</strong> ${escapeHtml(activity.description)}</p>` : ''}
        </div>`;

        // --- Stats Cards ---
        const statsContainer = document.getElementById('activity-detail-stats');
        let studentsOnTrack = 0, studentsBehind = 0, studentsAhead = 0;
        let teamsOnTrack = 0, teamsBehind = 0, teamsAhead = 0;

        // Find expected checkpoint (highest where suggested date passed AND a team has completed it)
        let highestExpected = 0;
        const todayStr = getTodayString();
        for (const cp of checkpoints) {
            const isPast = cp.suggestedDate && cp.suggestedDate <= todayStr;
            let anyTeamDone = false;
            for (const team of teams) {
                const members = teamMembers.filter(tm => tm.teamId === team.id).map(tm => tm.studentId);
                if (members.length === 0) continue;
                const done = members.filter(sid => completions.some(c => c.checkpointId === cp.id && c.studentId === sid && c.completed)).length;
                if (done > members.length / 2) { anyTeamDone = true; break; }
            }
            if (isPast && anyTeamDone) highestExpected = cp.number;
        }

        // Team stats
        teams.forEach(team => {
            const members = teamMembers.filter(tm => tm.teamId === team.id).map(tm => tm.studentId);
            if (members.length === 0) return;
            let teamHighest = 0;
            for (const cp of checkpoints) {
                const done = members.filter(sid => completions.some(c => c.checkpointId === cp.id && c.studentId === sid && c.completed)).length;
                if (done > members.length / 2) teamHighest = cp.number;
            }
            if (teamHighest > highestExpected) teamsAhead++;
            else if (teamHighest < highestExpected) teamsBehind++;
            else teamsOnTrack++;
        });

        // Student stats
        students.forEach(student => {
            let studentHighest = 0;
            for (const cp of checkpoints) {
                if (completions.some(c => c.checkpointId === cp.id && c.studentId === student.id && c.completed)) {
                    studentHighest = cp.number;
                }
            }
            if (studentHighest > highestExpected) studentsAhead++;
            else if (studentHighest < highestExpected) studentsBehind++;
            else studentsOnTrack++;
        });

        // Submissions & pipeline stats
        const allSubmissions = await db.submissions.toArray();
        const actSubs = allSubmissions.filter(s => s.activityId === activity.id);
        const graded = actSubs.filter(s => s.status === 'graded').length;

        // Pipeline status indicators (6.5)
        const pipelineContainer = document.getElementById('activity-pipeline-status');
        const hasForm = !!(activity.formUrl || activity.formSpreadsheetId);
        const imported = actSubs.filter(s => s.formResponses).length;
        const withFeedback = actSubs.filter(s => s.feedback && s.feedback.trim() !== '').length;

        // Check feedback send logs
        const feedbackLogs = await db.notes.where('entityType').equals('feedback-log').toArray();
        const actFeedbackLogs = feedbackLogs.filter(n => n.entityId === activity.id);
        const feedbackSent = actFeedbackLogs.length > 0;
        let feedbackSentCount = 0;
        if (feedbackSent) {
            const lastLog = actFeedbackLogs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            const match = lastLog.text?.match(/Sent (\d+)/);
            if (match) feedbackSentCount = parseInt(match[1]);
        }

        // Check Classroom push logs
        const classroomLogs = await db.notes.where('entityType').equals('classroom-push-log').toArray();
        const actClassroomLogs = classroomLogs.filter(n => n.entityId === activity.id);
        const classroomPushed = actClassroomLogs.length > 0;
        let classroomPushedCount = 0;
        if (classroomPushed) {
            const lastLog = actClassroomLogs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            const match = lastLog.text?.match(/Pushed (\d+)/);
            if (match) classroomPushedCount = parseInt(match[1]);
        }

        const hasClassroomLink = activity.classroomLinks && Object.keys(activity.classroomLinks).length > 0;

        const pipelineSteps = [
            { icon: '📋', label: 'Form', status: hasForm ? 'done' : 'na', detail: hasForm ? 'Linked' : 'No form' },
            { icon: '📥', label: 'Imported', status: imported > 0 ? 'done' : (hasForm ? 'pending' : 'na'), detail: imported > 0 ? imported + ' responses' : (hasForm ? 'Not yet' : '—') },
            { icon: '📝', label: 'Graded', status: graded > 0 ? (graded >= students.length ? 'done' : 'partial') : 'pending', detail: graded + '/' + students.length },
            { icon: '✉', label: 'Feedback', status: feedbackSent ? 'done' : (withFeedback > 0 ? 'partial' : 'pending'), detail: feedbackSent ? feedbackSentCount + ' sent' : (withFeedback > 0 ? withFeedback + ' written' : 'None') },
            { icon: '🎓', label: 'Classroom', status: classroomPushed ? 'done' : (hasClassroomLink ? 'pending' : 'na'), detail: classroomPushed ? classroomPushedCount + ' pushed' : (hasClassroomLink ? 'Ready' : 'Not linked') }
        ];

        const statusColors = { done: 'var(--color-success)', partial: 'var(--color-warning)', pending: 'var(--color-text-tertiary)', na: 'var(--color-text-tertiary)' };
        const statusBg = { done: 'rgba(var(--color-success-rgb, 34,197,94), 0.1)', partial: 'rgba(var(--color-warning-rgb, 234,179,8), 0.1)', pending: 'transparent', na: 'transparent' };

        pipelineContainer.innerHTML = `
            <div style="display: flex; align-items: center; gap: var(--space-xs); flex-wrap: wrap; padding: var(--space-sm) var(--space-base); background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md);">
                <span style="font-size: var(--font-size-body-small); font-weight: 600; color: var(--color-text-secondary); margin-right: var(--space-xs);">Pipeline:</span>
                ${pipelineSteps.map((step, i) => `
                    <span style="display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 12px; font-size: var(--font-size-caption); background: ${step.status === 'done' ? 'rgba(34,197,94,0.1)' : (step.status === 'partial' ? 'rgba(234,179,8,0.1)' : 'transparent')}; color: ${statusColors[step.status]}; ${step.status === 'na' ? 'opacity: 0.5;' : ''}">
                        ${step.icon} ${step.label}: ${step.detail}
                    </span>
                    ${i < pipelineSteps.length - 1 ? '<span style="color: var(--color-text-tertiary);">→</span>' : ''}
                `).join('')}
            </div>
        `;

        statsContainer.innerHTML = `
            <div class="card" style="padding: var(--space-base); text-align: center;">
                <div style="font-size: var(--font-size-caption); color: var(--color-text-secondary);">TEAMS ON TRACK</div>
                <div style="font-size: var(--font-size-h2); font-weight: bold; color: var(--color-success);">${teamsOnTrack + teamsAhead}</div>
                <div style="font-size: var(--font-size-caption); color: var(--color-text-tertiary);">${teamsBehind} behind</div>
            </div>
            <div class="card" style="padding: var(--space-base); text-align: center;">
                <div style="font-size: var(--font-size-caption); color: var(--color-text-secondary);">STUDENTS ON TRACK</div>
                <div style="font-size: var(--font-size-h2); font-weight: bold; color: var(--color-success);">${studentsOnTrack + studentsAhead}</div>
                <div style="font-size: var(--font-size-caption); color: var(--color-text-tertiary);">${studentsBehind} behind</div>
            </div>
            <div class="card" style="padding: var(--space-base); text-align: center;">
                <div style="font-size: var(--font-size-caption); color: var(--color-text-secondary);">GRADED</div>
                <div style="font-size: var(--font-size-h2); font-weight: bold; color: var(--color-info);">${graded}/${students.length}</div>
            </div>
            <div class="card" style="padding: var(--space-base); text-align: center;">
                <div style="font-size: var(--font-size-caption); color: var(--color-text-secondary);">EXPECTED CHECKPOINT</div>
                <div style="font-size: var(--font-size-h2); font-weight: bold;">${highestExpected || '—'}/${checkpoints.length}</div>
            </div>
        `;

        // --- Checkpoints Summary ---
        const cpContainer = document.getElementById('activity-detail-checkpoints-summary');
        if (checkpoints.length > 0) {
            let cpHtml = '<div class="card__header"><h3>Checkpoints</h3></div><div class="card__body"><table style="width: 100%; border-collapse: collapse; font-size: var(--font-size-body-small);">';
            cpHtml += '<thead><tr><th style="text-align: left; padding: var(--space-xs);">#</th><th style="text-align: left; padding: var(--space-xs);">Title</th><th style="text-align: center; padding: var(--space-xs);">Target Date</th><th style="text-align: center; padding: var(--space-xs);">Completion</th></tr></thead><tbody>';
            checkpoints.forEach(cp => {
                const completed = students.filter(s => completions.some(c => c.checkpointId === cp.id && c.studentId === s.id && c.completed)).length;
                const pct = students.length > 0 ? Math.round((completed / students.length) * 100) : 0;
                cpHtml += `<tr>
                    <td style="padding: var(--space-xs);">${cp.number}</td>
                    <td style="padding: var(--space-xs);">${escapeHtml(cp.title)}</td>
                    <td style="text-align: center; padding: var(--space-xs);">${cp.suggestedDate || '—'}</td>
                    <td style="text-align: center; padding: var(--space-xs);">
                        <div style="display: flex; align-items: center; gap: var(--space-xs); justify-content: center;">
                            <div style="flex: 1; max-width: 80px; height: 8px; background: var(--color-border); border-radius: 4px; overflow: hidden;">
                                <div style="width: ${pct}%; height: 100%; background: ${pct === 100 ? 'var(--color-success)' : 'var(--color-info)'}; border-radius: 4px;"></div>
                            </div>
                            <span>${completed}/${students.length}</span>
                        </div>
                    </td>
                </tr>`;
            });
            cpHtml += '</tbody></table></div>';
            cpContainer.innerHTML = cpHtml;
            cpContainer.style.display = '';
        } else {
            cpContainer.style.display = 'none';
        }
    },

    renderTeamTab: function(teams, checkpoints, completions, teamMembers, students) {
        const statusContainer = document.getElementById('activity-detail-team-status');
        const teamsContainer = document.getElementById('activity-detail-teams');

        // Calculate team statuses
        const todayStr = getTodayString();
        let highestExpected = 0;
        for (const cp of checkpoints) {
            const isPast = cp.suggestedDate && cp.suggestedDate <= todayStr;
            let anyTeamDone = false;
            for (const team of teams) {
                const members = teamMembers.filter(tm => tm.teamId === team.id).map(tm => tm.studentId);
                if (members.length === 0) continue;
                const done = members.filter(sid => completions.some(c => c.checkpointId === cp.id && c.studentId === sid && c.completed)).length;
                if (done > members.length / 2) { anyTeamDone = true; break; }
            }
            if (isPast && anyTeamDone) highestExpected = cp.number;
        }

        const ahead = [], onTrack = [], behind = [];
        teams.forEach(team => {
            const members = teamMembers.filter(tm => tm.teamId === team.id).map(tm => tm.studentId);
            let teamHighest = 0;
            for (const cp of checkpoints) {
                const done = members.filter(sid => completions.some(c => c.checkpointId === cp.id && c.studentId === sid && c.completed)).length;
                if (done > members.length / 2) teamHighest = cp.number;
            }
            const teamInfo = { ...team, highest: teamHighest, members };
            if (teamHighest > highestExpected) ahead.push(teamInfo);
            else if (teamHighest < highestExpected) behind.push(teamInfo);
            else onTrack.push(teamInfo);
        });

        let statusHtml = '<div style="display: flex; gap: var(--space-base); flex-wrap: wrap; margin-bottom: var(--space-base);">';
        if (ahead.length > 0) statusHtml += `<div class="card" style="flex: 1; min-width: 200px; padding: var(--space-sm); border-left: 4px solid #3b82f6;"><strong style="color: #3b82f6;">Ahead (${ahead.length})</strong><div style="font-size: var(--font-size-body-small); margin-top: 4px;">${ahead.map(t => escapeHtml(t.name)).join(', ')}</div></div>`;
        if (onTrack.length > 0) statusHtml += `<div class="card" style="flex: 1; min-width: 200px; padding: var(--space-sm); border-left: 4px solid var(--color-success);"><strong style="color: var(--color-success);">On Track (${onTrack.length})</strong><div style="font-size: var(--font-size-body-small); margin-top: 4px;">${onTrack.map(t => escapeHtml(t.name)).join(', ')}</div></div>`;
        if (behind.length > 0) statusHtml += `<div class="card" style="flex: 1; min-width: 200px; padding: var(--space-sm); border-left: 4px solid var(--color-error);"><strong style="color: var(--color-error);">Behind (${behind.length})</strong><div style="font-size: var(--font-size-body-small); margin-top: 4px;">${behind.map(t => escapeHtml(t.name)).join(', ')}</div></div>`;
        statusHtml += '</div>';
        statusContainer.innerHTML = statusHtml;

        // Team breakdown cards
        this.renderTeamProgress(teams, checkpoints, completions);
    },

    renderStudentTab: function(allStudents, checkpoints, completions, teamMembers, teams) {
        const statusContainer = document.getElementById('activity-detail-student-status');

        const todayStr = getTodayString();
        let highestExpected = 0;
        for (const cp of checkpoints) {
            const isPast = cp.suggestedDate && cp.suggestedDate <= todayStr;
            let anyTeamDone = false;
            for (const team of teams) {
                const members = teamMembers.filter(tm => tm.teamId === team.id).map(tm => tm.studentId);
                if (members.length === 0) continue;
                const done = members.filter(sid => completions.some(c => c.checkpointId === cp.id && c.studentId === sid && c.completed)).length;
                if (done > members.length / 2) { anyTeamDone = true; break; }
            }
            if (isPast && anyTeamDone) highestExpected = cp.number;
        }

        const ahead = [], onTrack = [], behind = [];
        allStudents.forEach(student => {
            let studentHighest = 0;
            for (const cp of checkpoints) {
                if (completions.some(c => c.checkpointId === cp.id && c.studentId === student.id && c.completed)) {
                    studentHighest = cp.number;
                }
            }
            if (studentHighest > highestExpected) ahead.push(displayName(student));
            else if (studentHighest < highestExpected) behind.push(displayName(student));
            else onTrack.push(displayName(student));
        });

        let statusHtml = '<div style="display: flex; gap: var(--space-base); flex-wrap: wrap; margin-bottom: var(--space-base);">';
        if (ahead.length > 0) statusHtml += `<div class="card" style="flex: 1; min-width: 200px; padding: var(--space-sm); border-left: 4px solid #3b82f6;"><strong style="color: #3b82f6;">Ahead (${ahead.length})</strong><div style="font-size: var(--font-size-body-small); margin-top: 4px;">${ahead.map(n => escapeHtml(n)).join(', ')}</div></div>`;
        if (onTrack.length > 0) statusHtml += `<div class="card" style="flex: 1; min-width: 200px; padding: var(--space-sm); border-left: 4px solid var(--color-success);"><strong style="color: var(--color-success);">On Track (${onTrack.length})</strong><div style="font-size: var(--font-size-body-small); margin-top: 4px;">${onTrack.map(n => escapeHtml(n)).join(', ')}</div></div>`;
        if (behind.length > 0) statusHtml += `<div class="card" style="flex: 1; min-width: 200px; padding: var(--space-sm); border-left: 4px solid var(--color-error);"><strong style="color: var(--color-error);">Behind (${behind.length})</strong><div style="font-size: var(--font-size-body-small); margin-top: 4px;">${behind.map(n => escapeHtml(n)).join(', ')}</div></div>`;
        statusHtml += '</div>';
        statusContainer.innerHTML = statusHtml;

        // Checkpoint completion chart
        this.renderStudentChart(allStudents, checkpoints, completions);
    },
    
    renderTeamProgress: async function(teams, checkpoints, completions) {
        const container = document.getElementById('activity-detail-teams');
        
        if (teams.length === 0) {
            container.innerHTML = '<p style="color: var(--color-text-tertiary);">No teams for this Class.</p>';
            return;
        }
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        container.innerHTML = '';
        container.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-base);';
        
        for (const team of teams) {
            const teamMemberRecords = await db.teamMembers
                .where('teamId')
                .equals(team.id)
                .toArray();
            const teamStudentIds = teamMemberRecords.map(tm => tm.studentId);
            
            // Find current checkpoint (first incomplete one)
            let currentCheckpoint = null;
            let completedCount = 0;
            
            for (const cp of checkpoints) {
                const allComplete = teamStudentIds.every(sid =>
                    completions.some(c =>
                        c.checkpointId === cp.id &&
                        c.studentId === sid &&
                        c.completed
                    )
                );
                
                if (allComplete) {
                    completedCount++;
                } else if (!currentCheckpoint) {
                    currentCheckpoint = cp;
                }
            }
            
            // Determine status (ahead, on track, behind)
            let status = 'on-track';
            let statusSymbol = '🟡';
            let statusText = 'On Track';
            let statusClass = 'activity-detail__alert--warning';
            
            if (currentCheckpoint && currentCheckpoint.suggestedDate) {
                const suggestedParts = currentCheckpoint.suggestedDate.split('-');
                const suggestedDate = new Date(suggestedParts[0], suggestedParts[1] - 1, suggestedParts[2]);
                
                if (today > suggestedDate) {
                    status = 'behind';
                    statusSymbol = '🔴';
                    statusText = 'Behind Schedule';
                    statusClass = 'activity-detail__alert--error';
                } else if (completedCount > currentCheckpoint.number - 1) {
                    status = 'ahead';
                    statusSymbol = '🔵';
                    statusText = 'Ahead of Schedule';
                    statusClass = 'activity-detail__alert--success';
                }
            }
            
            const currentCpText = currentCheckpoint 
                ? `Working on CP ${currentCheckpoint.number}: ${currentCheckpoint.title}`
                : '✅ All Checkpoints Complete';
            
            const card = document.createElement('div');
            card.className = `card activity-detail__alert ${statusClass}`;
            card.innerHTML = `
                <div class="card__body">
                    <div style="display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-sm);">
                        <span style="font-size: 24px;">${escapeHtml(statusSymbol)}</span>
                        <div>
                            <strong>${escapeHtml(team.name)}</strong>
                            <p style="font-size: var(--font-size-body-small); color: var(--color-text-secondary);">${statusText}</p>
                        </div>
                    </div>
                    <p style="font-size: var(--font-size-body-small);">${escapeHtml(currentCpText)}</p>
                    <p style="font-size: var(--font-size-body-small); margin-top: var(--space-xs);">Progress: ${completedCount}/${checkpoints.length} checkpoints</p>
                </div>
            `;
            container.appendChild(card);
        }
    },
    
    renderStudentChart: function(students, checkpoints, completions) {
        const container = document.getElementById('activity-detail-chart');
        
        if (students.length === 0 || checkpoints.length === 0) {
            container.innerHTML = '<p style="color: var(--color-text-tertiary);">No data to display.</p>';
            return;
        }
        
        let html = '<div class="checkpoint-chart"><table><thead><tr>';
        html += '<th>Student</th>';
        checkpoints.forEach(cp => {
            html += `<th>CP ${cp.number}</th>`;
        });
        html += '</tr></thead><tbody>';
        
        students.forEach(student => {
            html += `<tr><td>${escapeHtml(displayName(student))}</td>`;
            checkpoints.forEach(cp => {
                const completion = completions.find(c =>
                    c.checkpointId === cp.id &&
                    c.studentId === student.id &&
                    c.completed
                );
                
                if (completion && completion.completedAt) {
                    const date = new Date(completion.completedAt);
                    const formatted = date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
                    html += `<td class="complete">✅<br><small>${formatted}</small></td>`;
                } else {
                    html += `<td class="incomplete">❌</td>`;
                }
            });
            html += '</tr>';
        });
        
        html += '</tbody></table></div>';
        container.innerHTML = html;
    },

    renderSubmissions: async function(activity, students) {
        const container = document.getElementById('activity-submissions');
        const badge = document.getElementById('submissions-scoring-badge');
        const scoringType = activity.scoringType || 'complete-incomplete';

        const scoringLabels = { 'rubric': 'Rubric', 'points': 'Points', 'complete-incomplete': 'Complete/Incomplete' };
        badge.textContent = scoringLabels[scoringType] || 'Unknown';

        // Load existing submissions for this activity
        const allSubmissions = await db.submissions.toArray();
        const activitySubmissions = allSubmissions.filter(s => s.activityId === activity.id);
        const submissionMap = new Map(activitySubmissions.map(s => [s.studentId, s]));

        // Load checkpoint data for auto-status
        const checkpoints = await db.checkpoints.where('activityId').equals(activity.id).toArray();
        const allCompletions = await db.checkpointCompletions.toArray();

        // Auto-calculate and update statuses
        for (const student of students) {
            const sub = submissionMap.get(student.id);
            
            // Count completed checkpoints
            let cpCompleted = 0;
            for (const cp of checkpoints) {
                if (allCompletions.some(c => c.checkpointId === cp.id && c.studentId === student.id && c.completed)) {
                    cpCompleted++;
                }
            }

            // Determine auto-status
            let autoStatus = 'not-started';
            if (scoringType === 'rubric' && sub?.rubricScores && activity.rubric?.criteria?.length > 0 && activity.rubric.criteria.every(c => sub.rubricScores[c.name])) {
                autoStatus = 'graded';
            } else if (scoringType === 'points' && sub?.score != null) {
                autoStatus = 'graded';
            } else if (sub?.status === 'submitted') {
                autoStatus = 'submitted'; // preserve manual or Google Forms "submitted"
            } else if (cpCompleted > 0) {
                autoStatus = 'in-progress';
            }

            // Update if status has changed (don't downgrade manually set statuses)
            const currentStatus = sub?.status || 'not-started';
            const statusRank = { 'not-started': 0, 'in-progress': 1, 'submitted': 2, 'graded': 3 };
            if (statusRank[autoStatus] > statusRank[currentStatus]) {
                if (sub) {
                    const statusUpdate = { status: autoStatus, updatedAt: new Date().toISOString() };
                    // Sprint 13.5: Set gradedAt when auto-updating to graded
                    if (autoStatus === 'graded' && currentStatus !== 'graded') {
                        statusUpdate.gradedAt = new Date().toISOString();
                    }
                    await db.submissions.update(sub.id, statusUpdate);
                    sub.status = autoStatus;
                } else {
                    const newSub = {
                        activityId: activity.id,
                        studentId: student.id,
                        status: autoStatus,
                        submittedAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };
                    // Sprint 13.5: Set gradedAt for new submission created as graded
                    if (autoStatus === 'graded') {
                        newSub.gradedAt = new Date().toISOString();
                    }
                    const newId = await db.submissions.add(newSub);
                    newSub.id = newId;
                    submissionMap.set(student.id, newSub);
                }
            }
        }

        students = gradingSortStudents(students, submissionMap);

        if (students.length === 0) {
            container.innerHTML = '<p style="color: var(--color-text-tertiary);">No students found for this class.</p>';
            return;
        }

        // Checkpoint grade breakdown (6.6)
        let cpBreakdownHtml = '';
        if ((activity.checkpointGradeWeight || 0) > 0 && checkpoints.length > 0) {
            cpBreakdownHtml = '<details style="background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-base); margin-bottom: var(--space-base);">';
            cpBreakdownHtml += '<summary style="cursor: pointer; font-weight: 600; font-size: var(--font-size-body-small); user-select: none;">📊 Blended Grade Breakdown (Checkpoints: ' + activity.checkpointGradeWeight + '% | Assignment: ' + (100 - activity.checkpointGradeWeight) + '%)</summary>';
            cpBreakdownHtml += '<table style="width: 100%; border-collapse: collapse; font-size: var(--font-size-body-small);">';
            cpBreakdownHtml += '<thead><tr><th style="text-align: left; padding: 4px 8px;">Student</th><th style="text-align: center; padding: 4px 8px;">Checkpoints</th><th style="text-align: center; padding: 4px 8px;">Assignment</th><th style="text-align: center; padding: 4px 8px; font-weight: 700;">Final</th></tr></thead><tbody>';

            students.forEach(function(student) {
                const sub = submissionMap.get(student.id);
                const result = calculateFinalGrade(activity, student.id, sub, checkpoints, allCompletions);

                const cpPct = Math.round(result.cpScore * 100);
                const assignPct = Math.round(result.assignmentScore * 100);
                const finalPct = Math.round(result.finalScore * 100);

                const cpContrib = Math.round(result.cpScore * result.cpWeight * 100);
                const assignContrib = Math.round(result.assignmentScore * result.assignmentWeight * 100);

                cpBreakdownHtml += '<tr style="border-bottom: 1px solid var(--color-border);">';
                cpBreakdownHtml += '<td style="padding: 4px 8px;">' + escapeHtml(displayName(student)) + '</td>';
                cpBreakdownHtml += '<td style="text-align: center; padding: 4px 8px; color: var(--color-text-secondary);">' + cpPct + '% → ' + cpContrib + '%</td>';
                cpBreakdownHtml += '<td style="text-align: center; padding: 4px 8px; color: var(--color-text-secondary);">' + assignPct + '% → ' + assignContrib + '%</td>';
                cpBreakdownHtml += '<td style="text-align: center; padding: 4px 8px; font-weight: 700;">' + finalPct + '%</td>';
                cpBreakdownHtml += '</tr>';
            });

            cpBreakdownHtml += '</tbody></table></details>';
        }

        // Query which students already received feedback today (for per-student send buttons)
        const todayStr = getTodayString();
        const automationsOn = localStorage.getItem('automations-enabled') === 'true';
        const webhookUrl = localStorage.getItem('webhook_absent') || localStorage.getItem('webhook_wildcat');
        const showSendBtns = automationsOn && !!webhookUrl;
        let sentToday = new Set();
        if (showSendBtns) {
            const feedbackLogs = await db.notes.where('entityType').equals('feedback-log').toArray();
            sentToday = new Set(
                feedbackLogs
                    .filter(n => n.createdAt && n.createdAt.startsWith(todayStr))
                    .map(n => n.entityId)
            );
        }

        if (scoringType === 'rubric' || (await db.activitySkills.where('activityId').equals(activity.id).count()) > 0) {
            await this.renderRubricGrading(container, activity, students, submissionMap, showSendBtns, sentToday);
        } else if (scoringType === 'points') {
            this.renderPointsGrading(container, activity, students, submissionMap, showSendBtns, sentToday);
        } else {
            this.renderCompleteIncompleteGrading(container, activity, students, submissionMap, showSendBtns, sentToday);
        }

        // Prepend checkpoint breakdown above the grading cards
        if (cpBreakdownHtml) {
            container.innerHTML = cpBreakdownHtml + container.innerHTML;
        }

        // Show/hide Send All Feedback button
        const feedbackBtn = document.getElementById('send-feedback-btn');
        if (feedbackBtn) {
            const automationsOn = localStorage.getItem('automations-enabled') === 'true';
            const webhookUrl = localStorage.getItem('webhook_absent') || localStorage.getItem('webhook_wildcat');
            const hasFeedback = [...submissionMap.values()].some(s => s?.feedback && s.feedback.trim() !== '');
            feedbackBtn.style.display = (automationsOn && webhookUrl && hasFeedback) ? '' : 'none';
        }

        // Show/hide Export Grades buttons — visible whenever any submissions exist
        const hasAnySubmissions = submissionMap.size > 0;
        const classroomExportBtn = document.getElementById('export-grades-classroom-btn');
        const progressbookExportBtn = document.getElementById('export-grades-progressbook-btn');
        if (classroomExportBtn) classroomExportBtn.style.display = hasAnySubmissions ? '' : 'none';
        if (progressbookExportBtn) progressbookExportBtn.style.display = hasAnySubmissions ? '' : 'none';

        // Show/hide Push to Classroom button (6.4)
        const classroomBtn = document.getElementById('push-classroom-btn');
        if (classroomBtn) {
            const actForBtn = await db.activities.get(state.selectedActivity);
            const hasClassroomLink = actForBtn && actForBtn.classroomLinks && Object.keys(actForBtn.classroomLinks).length > 0;
            const automationsOn = localStorage.getItem('automations-enabled') === 'true';
            const webhookUrl = localStorage.getItem('webhook_absent') || localStorage.getItem('webhook_wildcat');
            classroomBtn.style.display = (hasClassroomLink && automationsOn && webhookUrl) ? '' : 'none';
        }
    },

    renderCompleteIncompleteGrading: function(container, activity, students, submissionMap, showSendBtns, sentToday) {
        let html = '<div style="margin-bottom: var(--space-sm); text-align: right;"><button class="btn btn--secondary" style="font-size: 12px; padding: 4px 12px;" onclick="(function(btn){ var rows=btn.closest(\'div\').parentElement.querySelectorAll(\'.fb-collapse-row\'); var hide=rows[0]&&rows[0].style.display!==\'none\'; rows.forEach(function(r){r.style.display=hide?\'none\':\'table-row\';}); btn.textContent=hide?\'Expand Feedback\':\'Collapse Feedback\';})(this)">Collapse Feedback</button></div>';
        html += '<table style="width: 100%; border-collapse: collapse;">';
        html += '<thead><tr><th style="text-align: left; padding: var(--space-sm); border-bottom: 2px solid var(--color-border);">Student</th>';
        html += '<th style="text-align: center; padding: var(--space-sm); border-bottom: 2px solid var(--color-border);">Status</th></tr></thead><tbody>';

        students.forEach(student => {
            const sub = submissionMap.get(student.id);
            const status = sub?.status || 'not-started';
            const statusColors = {
                'not-started': 'var(--color-text-tertiary)',
                'in-progress': 'var(--color-warning)',
                'submitted': 'var(--color-info)',
                'graded': 'var(--color-success)'
            };
            const bgColors = {
                'not-started': 'rgba(220, 38, 38, 0.06)',
                'in-progress': 'rgba(234, 179, 8, 0.08)',
                'submitted': 'rgba(22, 163, 74, 0.06)',
                'graded': 'rgba(59, 130, 246, 0.06)'
            };

            html += `<tr style="background: ${bgColors[status] || ''};">
                <td style="padding: var(--space-sm); border-bottom: 1px solid var(--color-border); font-weight: 500;">${escapeHtml(displayName(student))}</td>
                <td style="padding: var(--space-sm); border-bottom: 1px solid var(--color-border); text-align: center;">
                    <select onchange="pages.activityDetail.saveSubmission(${activity.id}, ${student.id}, this.value, null)" style="padding: 4px 8px; border-radius: var(--radius-sm); border: 1px solid var(--color-border); color: ${statusColors[status]};">
                        <option value="not-started" ${status === 'not-started' ? 'selected' : ''}>Not Started</option>
                        <option value="in-progress" ${status === 'in-progress' ? 'selected' : ''}>In Progress</option>
                        <option value="submitted" ${status === 'submitted' ? 'selected' : ''}>Submitted</option>
                        <option value="graded" ${status === 'graded' ? 'selected' : ''}>Complete</option>
                    </select>
                    ${(() => { const attemptCount = (sub?.attempts?.length || 0) + 1; return attemptCount > 1 ? `<div style="margin-top: var(--space-xs); font-size: var(--font-size-body-small); color: var(--color-text-secondary);"><strong>Attempt ${attemptCount} of ${attemptCount}</strong> <button class="btn btn--secondary" style="padding: 2px 8px; font-size: 11px; margin-left: var(--space-sm);" onclick="pages.activityDetail.showAttemptHistory(${activity.id}, ${student.id}, event)">View History</button></div>` : ''; })()}
                </td>
            </tr>`;

            // Teacher feedback row
            const hasFbCI = sub?.feedback && sub.feedback.trim() !== '';
            const sentTodayCI = sentToday.has(student.id);
            html += `<tr class="fb-collapse-row" style="background: ${bgColors[status] || ''};">
                <td colspan="2" style="padding: 0 var(--space-sm) var(--space-sm); border-bottom: 1px solid var(--color-border);">
                    <textarea id="fb-text-${student.id}" placeholder="Add feedback for ${escapeHtml(displayName(student))}..."
                        onblur="pages.activityDetail.saveFeedback(${activity.id}, ${student.id}, this.value)"
                        oninput="var b=document.getElementById('send-fb-${student.id}'); if(b && !b.textContent.startsWith('✓')) b.disabled=!this.value.trim();"
                        style="width: 100%; min-height: 50px; padding: var(--space-xs); border: 1px solid var(--color-border); border-radius: var(--radius-sm); font-size: var(--font-size-body-small); font-family: inherit; resize: vertical; box-sizing: border-box;"
                    >${escapeHtml(sub?.feedback || '')}</textarea>
                    ${showSendBtns ? `<div style="text-align: right; margin-top: 4px;">
                        <button id="send-fb-${student.id}" class="btn btn--secondary" style="font-size: 11px; padding: 2px 10px;"
                            onclick="pages.activityDetail.sendStudentFeedback(${activity.id}, ${student.id})"
                            ${sentTodayCI ? 'disabled' : (!hasFbCI ? 'disabled' : '')}>${sentTodayCI ? '✓ Sent' : '✉ Send'}</button>
                    </div>` : ''}
                    ${(() => {
                        const meCI = (sub?.raceScores || []).find(e => e.question === 'Manual Entry');
                        return `<details style="margin-top: var(--space-xs);">
                            <summary style="cursor: pointer; font-size: var(--font-size-body-small); font-weight: 600; color: var(--color-text-secondary); user-select: none;">✏️ RACE Scores</summary>
                            <div style="display: flex; gap: var(--space-sm); align-items: center; margin-top: var(--space-xs); flex-wrap: wrap;">
                                <label style="font-size: var(--font-size-body-small);">R <input type="number" min="0" max="5" step="1" id="race-r-${student.id}" value="${meCI?.R ?? ''}" style="width: 50px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); text-align: center;"></label>
                                <label style="font-size: var(--font-size-body-small);">A <input type="number" min="0" max="5" step="1" id="race-a-${student.id}" value="${meCI?.A ?? ''}" style="width: 50px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); text-align: center;"></label>
                                <label style="font-size: var(--font-size-body-small);">C <input type="number" min="0" max="5" step="1" id="race-c-${student.id}" value="${meCI?.C ?? ''}" style="width: 50px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); text-align: center;"></label>
                                <label style="font-size: var(--font-size-body-small);">E <input type="number" min="0" max="5" step="1" id="race-e-${student.id}" value="${meCI?.E ?? ''}" style="width: 50px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); text-align: center;"></label>
                                <button class="btn btn--primary" style="font-size: 11px; padding: 4px 10px;" onclick="pages.activityDetail.saveRaceScores(${activity.id}, ${student.id})">Save RACE Scores</button>
                            </div>
                        </details>`;
                    })()}
                </td>
            </tr>`;

            // Form responses expandable row
            if (sub?.formResponses?.answers?.length > 0) {
                const fr = sub.formResponses;
                html += `<tr style="background: ${bgColors[status] || ''};">
                    <td colspan="2" style="padding: 0 var(--space-sm) var(--space-sm); border-bottom: 1px solid var(--color-border);">
                        <details>
                            <summary style="cursor: pointer; font-size: var(--font-size-body-small); font-weight: 600; color: var(--color-text-secondary); user-select: none;">
                                📋 Form Responses${fr.totalScore != null ? ` — Score: ${fr.totalScore}${fr.totalPossible ? '/' + fr.totalPossible : ''}` : ''}
                            </summary>
                            <div style="margin-top: var(--space-xs); font-size: var(--font-size-body-small);">
                                ${fr.answers.map((a, idx) => `
                                    <div style="padding: 6px 0; ${idx > 0 ? 'border-top: 1px solid var(--color-border);' : ''}">
                                        <div style="font-weight: 600; color: var(--color-text-secondary); margin-bottom: 2px;">${escapeHtml(a.question)}</div>
                                        <div style="color: var(--color-text-primary);">${escapeHtml(a.answer || '—')}</div>
                                        ${a.score != null ? `<div style="color: var(--color-info); margin-top: 2px;">Score: ${a.score}${a.maxPoints ? '/' + a.maxPoints : ''}</div>` : ''}
                                        ${a.autoFeedback ? `<div style="color: var(--color-text-tertiary); font-style: italic; margin-top: 2px;">${escapeHtml(a.autoFeedback)}</div>` : ''}
                                    </div>
                                `).join('')}
                                ${fr.autoFeedback ? `<div style="padding: 6px 0; border-top: 1px solid var(--color-border); color: var(--color-text-tertiary); font-style: italic;">Overall: ${escapeHtml(fr.autoFeedback)}</div>` : ''}
                            </div>
                        </details>
                    </td>
                </tr>`;
            }
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    },

    renderPointsGrading: function(container, activity, students, submissionMap, showSendBtns, sentToday) {
        const maxPoints = activity.defaultPoints || 100;
        let html = '<div style="margin-bottom: var(--space-sm); text-align: right;"><button class="btn btn--secondary" style="font-size: 12px; padding: 4px 12px;" onclick="(function(btn){ var rows=btn.closest(\'div\').parentElement.querySelectorAll(\'.fb-collapse-row\'); var hide=rows[0]&&rows[0].style.display!==\'none\'; rows.forEach(function(r){r.style.display=hide?\'none\':\'table-row\';}); btn.textContent=hide?\'Expand Feedback\':\'Collapse Feedback\';})(this)">Collapse Feedback</button></div>';
        html += '<table style="width: 100%; border-collapse: collapse;">';
        html += `<thead><tr>
            <th style="text-align: left; padding: var(--space-sm); border-bottom: 2px solid var(--color-border);">Student</th>
            <th style="text-align: center; padding: var(--space-sm); border-bottom: 2px solid var(--color-border);">Score (/${maxPoints})</th>
            <th style="text-align: center; padding: var(--space-sm); border-bottom: 2px solid var(--color-border);">Status</th>
        </tr></thead><tbody>`;

        students.forEach(student => {
            const sub = submissionMap.get(student.id);
            const status = sub?.status || 'not-started';
            const score = sub?.score ?? '';
            const pct = score !== '' ? Math.round((score / maxPoints) * 100) : null;
            const statusBgColors = { 'not-started': 'rgba(220, 38, 38, 0.06)', 'in-progress': 'rgba(234, 179, 8, 0.08)', 'submitted': 'rgba(22, 163, 74, 0.06)', 'graded': 'rgba(59, 130, 246, 0.06)' };
            const bgColor = statusBgColors[status] || '';

            html += `<tr style="background: ${bgColor};">
                <td style="padding: var(--space-sm); border-bottom: 1px solid var(--color-border); font-weight: 500;">${escapeHtml(displayName(student))}</td>
                <td style="padding: var(--space-sm); border-bottom: 1px solid var(--color-border); text-align: center;">
                    <input type="number" min="0" max="${maxPoints}" value="${score}" placeholder="—"
                        style="width: 70px; text-align: center; padding: 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm);"
                        onchange="pages.activityDetail.saveSubmission(${activity.id}, ${student.id}, 'graded', parseFloat(this.value))">
                    ${pct !== null ? `<span style="font-size: var(--font-size-body-small); color: var(--color-text-tertiary); margin-left: 4px;">(${pct}%)</span>` : ''}
                </td>
                <td style="padding: var(--space-sm); border-bottom: 1px solid var(--color-border); text-align: center;">
                    <select onchange="pages.activityDetail.saveSubmission(${activity.id}, ${student.id}, this.value, null)" style="padding: 4px 8px; border-radius: var(--radius-sm); border: 1px solid var(--color-border);">
                        <option value="not-started" ${status === 'not-started' ? 'selected' : ''}>Not Started</option>
                        <option value="in-progress" ${status === 'in-progress' ? 'selected' : ''}>In Progress</option>
                        <option value="submitted" ${status === 'submitted' ? 'selected' : ''}>Submitted</option>
                        <option value="graded" ${status === 'graded' ? 'selected' : ''}>Graded</option>
                    </select>
                    ${(() => { const attemptCount = (sub?.attempts?.length || 0) + 1; return attemptCount > 1 ? `<div style="margin-top: var(--space-xs); font-size: var(--font-size-body-small); color: var(--color-text-secondary);"><strong>Attempt ${attemptCount} of ${attemptCount}</strong> <button class="btn btn--secondary" style="padding: 2px 8px; font-size: 11px; margin-left: var(--space-sm);" onclick="pages.activityDetail.showAttemptHistory(${activity.id}, ${student.id}, event)">View History</button></div>` : ''; })()}
                </td>
            </tr>`;

            // Teacher feedback row
            const hasFbPts = sub?.feedback && sub.feedback.trim() !== '';
            const sentTodayPts = sentToday.has(student.id);
            html += `<tr class="fb-collapse-row" style="background: ${bgColor};">
                <td colspan="3" style="padding: 0 var(--space-sm) var(--space-sm); border-bottom: 1px solid var(--color-border);">
                    <textarea id="fb-text-${student.id}" placeholder="Add feedback for ${escapeHtml(displayName(student))}..."
                        onblur="pages.activityDetail.saveFeedback(${activity.id}, ${student.id}, this.value)"
                        oninput="var b=document.getElementById('send-fb-${student.id}'); if(b && !b.textContent.startsWith('✓')) b.disabled=!this.value.trim();"
                        style="width: 100%; min-height: 50px; padding: var(--space-xs); border: 1px solid var(--color-border); border-radius: var(--radius-sm); font-size: var(--font-size-body-small); font-family: inherit; resize: vertical; box-sizing: border-box;"
                    >${escapeHtml(sub?.feedback || '')}</textarea>
                    ${showSendBtns ? `<div style="text-align: right; margin-top: 4px;">
                        <button id="send-fb-${student.id}" class="btn btn--secondary" style="font-size: 11px; padding: 2px 10px;"
                            onclick="pages.activityDetail.sendStudentFeedback(${activity.id}, ${student.id})"
                            ${sentTodayPts ? 'disabled' : (!hasFbPts ? 'disabled' : '')}>${sentTodayPts ? '✓ Sent' : '✉ Send'}</button>
                    </div>` : ''}
                    ${(() => {
                        const mePts = (sub?.raceScores || []).find(e => e.question === 'Manual Entry');
                        return `<details style="margin-top: var(--space-xs);">
                            <summary style="cursor: pointer; font-size: var(--font-size-body-small); font-weight: 600; color: var(--color-text-secondary); user-select: none;">✏️ RACE Scores</summary>
                            <div style="display: flex; gap: var(--space-sm); align-items: center; margin-top: var(--space-xs); flex-wrap: wrap;">
                                <label style="font-size: var(--font-size-body-small);">R <input type="number" min="0" max="5" step="1" id="race-r-${student.id}" value="${mePts?.R ?? ''}" style="width: 50px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); text-align: center;"></label>
                                <label style="font-size: var(--font-size-body-small);">A <input type="number" min="0" max="5" step="1" id="race-a-${student.id}" value="${mePts?.A ?? ''}" style="width: 50px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); text-align: center;"></label>
                                <label style="font-size: var(--font-size-body-small);">C <input type="number" min="0" max="5" step="1" id="race-c-${student.id}" value="${mePts?.C ?? ''}" style="width: 50px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); text-align: center;"></label>
                                <label style="font-size: var(--font-size-body-small);">E <input type="number" min="0" max="5" step="1" id="race-e-${student.id}" value="${mePts?.E ?? ''}" style="width: 50px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); text-align: center;"></label>
                                <button class="btn btn--primary" style="font-size: 11px; padding: 4px 10px;" onclick="pages.activityDetail.saveRaceScores(${activity.id}, ${student.id})">Save RACE Scores</button>
                            </div>
                        </details>`;
                    })()}
                </td>
            </tr>`;

            // Form responses expandable row
            if (sub?.formResponses?.answers?.length > 0) {
                const fr = sub.formResponses;
                html += `<tr style="background: ${bgColor};">
                    <td colspan="3" style="padding: 0 var(--space-sm) var(--space-sm); border-bottom: 1px solid var(--color-border);">
                        <details>
                            <summary style="cursor: pointer; font-size: var(--font-size-body-small); font-weight: 600; color: var(--color-text-secondary); user-select: none;">
                                📋 Form Responses${fr.totalScore != null ? ` — Score: ${fr.totalScore}${fr.totalPossible ? '/' + fr.totalPossible : ''}` : ''}
                            </summary>
                            <div style="margin-top: var(--space-xs); font-size: var(--font-size-body-small);">
                                ${fr.answers.map((a, idx) => `
                                    <div style="padding: 6px 0; ${idx > 0 ? 'border-top: 1px solid var(--color-border);' : ''}">
                                        <div style="font-weight: 600; color: var(--color-text-secondary); margin-bottom: 2px;">${escapeHtml(a.question)}</div>
                                        <div style="color: var(--color-text-primary);">${escapeHtml(a.answer || '—')}</div>
                                        ${a.score != null ? `<div style="color: var(--color-info); margin-top: 2px;">Score: ${a.score}${a.maxPoints ? '/' + a.maxPoints : ''}</div>` : ''}
                                        ${a.autoFeedback ? `<div style="color: var(--color-text-tertiary); font-style: italic; margin-top: 2px;">${escapeHtml(a.autoFeedback)}</div>` : ''}
                                    </div>
                                `).join('')}
                                ${fr.autoFeedback ? `<div style="padding: 6px 0; border-top: 1px solid var(--color-border); color: var(--color-text-tertiary); font-style: italic;">Overall: ${escapeHtml(fr.autoFeedback)}</div>` : ''}
                            </div>
                        </details>
                    </td>
                </tr>`;
            }
        });

        html += '</tbody></table>';
        container.innerHTML = html;
        // Add form mapping config above student cards
        this.renderFormMappingConfig(container, activity, submissionMap);
    },

    renderFormMappingConfig: function(container, activity, submissionMap) {
        if (!activity.rubric || !activity.rubric.criteria || !activity.formSpreadsheetId) return;

        const criteria = activity.rubric.criteria;
        const sampleSub = [...submissionMap.values()].find(s => s?.formResponses?.answers?.length > 0);
        const formQuestionCount = sampleSub ? sampleSub.formResponses.answers.length : 0;

        const hasMappings = criteria.some(c => c.formQuestionFrom != null);
        const mappingStatus = hasMappings
            ? `<span style="color: var(--color-success);">✅ Configured</span>`
            : (formQuestionCount > 0 ? `<span style="color: var(--color-warning);">⚠️ Not configured</span>` : `<span style="color: var(--color-text-tertiary);">No form data yet — check submissions first</span>`);

        let mappingHtml = `<div style="border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-base); margin-bottom: var(--space-lg); background: var(--color-background-secondary);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-sm);">
                <strong style="font-size: var(--font-size-body-small);">📊 Form → Rubric Mapping</strong>
                ${mappingStatus}
            </div>`;

        if (formQuestionCount > 0) {
            const questionNames = sampleSub.formResponses.answers.map((a, i) => `Q${i + 1}: ${a.question}`);
            mappingHtml += `<details style="margin-bottom: var(--space-sm);">
                <summary style="cursor: pointer; font-size: var(--font-size-body-small); color: var(--color-text-secondary);">View ${formQuestionCount} form questions</summary>
                <div style="font-size: var(--font-size-body-small); color: var(--color-text-tertiary); margin-top: var(--space-xs); padding: var(--space-xs);">
                    ${questionNames.map(q => `<div style="padding: 2px 0;">${escapeHtml(q)}</div>`).join('')}
                </div>
            </details>`;

            mappingHtml += `<div style="display: flex; flex-direction: column; gap: var(--space-xs);">`;
            criteria.forEach((criterion, idx) => {
                const fromVal = criterion.formQuestionFrom || '';
                const toVal = criterion.formQuestionTo || '';
                mappingHtml += `<div style="display: flex; align-items: center; gap: var(--space-sm); font-size: var(--font-size-body-small);">
                    <span style="font-weight: 500; min-width: 120px;">${escapeHtml(criterion.name)}</span>
                    <span>Q</span>
                    <input type="number" min="1" max="${formQuestionCount}" value="${fromVal}" 
                        class="form-input form-mapping-from" data-criterion-index="${idx}"
                        style="width: 60px; padding: 4px 8px; text-align: center;">
                    <span>to Q</span>
                    <input type="number" min="1" max="${formQuestionCount}" value="${toVal}"
                        class="form-input form-mapping-to" data-criterion-index="${idx}"
                        style="width: 60px; padding: 4px 8px; text-align: center;">
                </div>`;
            });
            mappingHtml += `</div>
                <button class="btn btn--primary" style="margin-top: var(--space-sm); font-size: var(--font-size-body-small);"
                    onclick="pages.activityDetail.saveFormMapping(${activity.id})">Save Mapping</button>`;
        }

        mappingHtml += `</div>`;

        // Prepend to container
        const mappingDiv = document.createElement('div');
        mappingDiv.innerHTML = mappingHtml;
        container.prepend(mappingDiv);
    },

    renderRubricGrading: async function(container, activity, students, submissionMap, showSendBtns, sentToday) {
        const rubric = activity.rubric;
        const hasRubric = rubric && rubric.levels && rubric.criteria && rubric.criteria.length > 0;

        // Load linked skills for this assignment
        const linkedSkillRecords = await db.activitySkills.where('activityId').equals(activity.id).toArray();
        const linkedSkillIds = linkedSkillRecords.map(l => l.skillId);
        const linkedSkills = linkedSkillIds.length > 0
            ? (await db.skills.toArray()).filter(s => linkedSkillIds.includes(s.id))
            : [];
        const skillLevels = ['Advanced', 'Proficient', 'Developing', 'Novice'];

        if (!hasRubric && linkedSkills.length === 0) {
            container.innerHTML = '<p style="color: var(--color-text-tertiary);">No rubric or skills defined for this assignment. Edit the assignment to add rubric criteria or link skills.</p>';
            return;
        }

        const levels = hasRubric ? rubric.levels : [];
        const criteria = hasRubric ? rubric.criteria : [];
        // --- Form → Rubric Mapping Config ---
        // Show mapping UI if form is linked and we have rubric criteria
        if (hasRubric && activity.formSpreadsheetId) {
            // Find any submission with formResponses to get question count
            const sampleSub = [...submissionMap.values()].find(s => s?.formResponses?.answers?.length > 0);
            const formQuestionCount = sampleSub ? sampleSub.formResponses.answers.length : 0;

            const hasMappings = criteria.some(c => c.formQuestionFrom != null);
            const mappingStatus = hasMappings
                ? `<span style="color: var(--color-success);">✅ Configured</span>`
                : (formQuestionCount > 0 ? `<span style="color: var(--color-warning);">⚠️ Not configured</span>` : `<span style="color: var(--color-text-tertiary);">No form data yet — check submissions first</span>`);

            let mappingHtml = `<div style="border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-base); margin-bottom: var(--space-lg); background: var(--color-background-secondary);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-sm);">
                    <strong style="font-size: var(--font-size-body-small);">Form → Rubric Mapping</strong>
                    ${mappingStatus}
                </div>`;

            if (formQuestionCount > 0) {
                // Show question names for reference
                const questionNames = sampleSub.formResponses.answers.map((a, i) => `Q${i + 1}: ${a.question}`);
                mappingHtml += `<details style="margin-bottom: var(--space-sm);">
                    <summary style="cursor: pointer; font-size: var(--font-size-body-small); color: var(--color-text-secondary);">View ${formQuestionCount} form questions</summary>
                    <div style="font-size: var(--font-size-body-small); color: var(--color-text-tertiary); margin-top: var(--space-xs); padding: var(--space-xs);">
                        ${questionNames.map(q => `<div style="padding: 2px 0;">${escapeHtml(q)}</div>`).join('')}
                    </div>
                </details>`;

                mappingHtml += `<div style="display: flex; flex-direction: column; gap: var(--space-xs);">`;
                criteria.forEach((criterion, idx) => {
                    const fromVal = criterion.formQuestionFrom || '';
                    const toVal = criterion.formQuestionTo || '';
                    mappingHtml += `<div style="display: flex; align-items: center; gap: var(--space-sm); font-size: var(--font-size-body-small);">
                        <span style="font-weight: 500; min-width: 120px;">${escapeHtml(criterion.name)}</span>
                        <span>Q</span>
                        <input type="number" min="1" max="${formQuestionCount}" value="${fromVal}" 
                            class="form-input form-mapping-from" data-criterion-index="${idx}"
                            style="width: 60px; padding: 4px 8px; text-align: center;">
                        <span>to Q</span>
                        <input type="number" min="1" max="${formQuestionCount}" value="${toVal}"
                            class="form-input form-mapping-to" data-criterion-index="${idx}"
                            style="width: 60px; padding: 4px 8px; text-align: center;">
                    </div>`;
                });
                mappingHtml += `</div>
                    <button class="btn btn--primary" style="margin-top: var(--space-sm); font-size: var(--font-size-body-small);"
                        onclick="pages.activityDetail.saveFormMapping(${activity.id})">Save Mapping</button>`;
            }

            mappingHtml += `</div>`;
            container.innerHTML = mappingHtml;
        } else {
            container.innerHTML = '';
        }
        let html = container.innerHTML;
        students.forEach(student => {
            const sub = submissionMap.get(student.id);
            const rubricScores = sub?.rubricScores || {};
            const studentSkillScores = sub?.skillScores || {};

            const statusColors = { 'not-started': 'rgba(220, 38, 38, 0.06)', 'in-progress': 'rgba(234, 179, 8, 0.08)', 'submitted': 'rgba(22, 163, 74, 0.06)', 'graded': 'rgba(59, 130, 246, 0.06)' };
            const statusBorders = { 'not-started': '#dc2626', 'in-progress': '#eab308', 'submitted': '#16a34a', 'graded': '#3b82f6' };
            const currentStatus = sub?.status || 'not-started';

            html += `<details style="border: 1px solid ${statusBorders[currentStatus] || 'var(--color-border)'}; border-left: 4px solid ${statusBorders[currentStatus] || 'var(--color-border)'}; border-radius: var(--radius-md); margin-bottom: var(--space-sm); background: ${statusColors[currentStatus] || ''};">
                <summary style="display: flex; justify-content: space-between; align-items: center; padding: var(--space-base); cursor: pointer; user-select: none;">
                    <strong>${escapeHtml(displayName(student))}</strong>
                    <select onclick="event.stopPropagation()" onchange="pages.activityDetail.saveSubmission(${activity.id}, ${student.id}, this.value, null)" style="padding: 4px 8px; border-radius: var(--radius-sm); border: 1px solid var(--color-border);">
                        <option value="not-started" ${currentStatus === 'not-started' ? 'selected' : ''}>Not Started</option>
                        <option value="in-progress" ${currentStatus === 'in-progress' ? 'selected' : ''}>In Progress</option>
                        <option value="submitted" ${currentStatus === 'submitted' ? 'selected' : ''}>Submitted</option>
                        <option value="graded" ${currentStatus === 'graded' ? 'selected' : ''}>Graded</option>
                    </select>
                </summary>
                <div style="padding: 0 var(--space-base) var(--space-base);">`;

            // --- Graded Rubric Criteria ---
            if (hasRubric && criteria.length > 0) {
                html += `<table style="width: 100%; border-collapse: collapse; font-size: var(--font-size-body-small);">
                    <thead><tr>
                        <th style="text-align: left; padding: 4px; border-bottom: 1px solid var(--color-border);">Graded Criteria</th>
                        ${levels.map(l => `<th style="text-align: center; padding: 4px; border-bottom: 1px solid var(--color-border);">${escapeHtml(l)}</th>`).join('')}
                    </tr></thead><tbody>`;

                criteria.forEach(criterion => {
                    const selected = rubricScores[criterion.name] || '';
                    html += `<tr><td style="padding: 4px; border-bottom: 1px solid var(--color-border); font-weight: 500;">${escapeHtml(criterion.name)}</td>`;
                    levels.forEach(level => {
                        const isSelected = selected === level;
                        html += `<td style="text-align: center; padding: 4px; border-bottom: 1px solid var(--color-border);">
                            <button onclick="pages.activityDetail.saveRubricScore(${activity.id}, ${student.id}, '${escapeHtml(criterion.name)}', '${escapeHtml(level)}')"
                                style="width: 32px; height: 32px; border-radius: var(--radius-circle); border: 2px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}; background: ${isSelected ? 'var(--color-primary)' : 'var(--color-background)'}; color: ${isSelected ? 'white' : 'var(--color-text-tertiary)'}; cursor: pointer; font-size: 12px; font-weight: 600;">
                                ${isSelected ? '✓' : ''}
                            </button>
                        </td>`;
                    });
                    html += '</tr>';
                });
                html += '</tbody></table>';
            }

            // --- Skill Assessment (not graded) ---
            if (linkedSkills.length > 0) {
                html += `<div style="margin-top: var(--space-sm); padding-top: var(--space-sm); border-top: 2px dashed var(--color-border);">
                    <table style="width: 100%; border-collapse: collapse; font-size: var(--font-size-body-small);">
                    <thead><tr>
                        <th style="text-align: left; padding: 4px; border-bottom: 1px solid var(--color-border); color: var(--color-info);">Skill Assessment <span style="font-weight: normal; font-style: italic;">(not graded)</span></th>
                        ${skillLevels.map(l => `<th style="text-align: center; padding: 4px; border-bottom: 1px solid var(--color-border); color: var(--color-info);">${escapeHtml(l)}</th>`).join('')}
                    </tr></thead><tbody>`;

                linkedSkills.forEach(skill => {
                    const selected = studentSkillScores[String(skill.id)] || '';
                    html += `<tr><td style="padding: 4px; border-bottom: 1px solid var(--color-border); font-weight: 500;">${escapeHtml(skill.name)}</td>`;
                    skillLevels.forEach(level => {
                        const isSelected = selected === level;
                        const skillColor = '#3b82f6';
                        html += `<td style="text-align: center; padding: 4px; border-bottom: 1px solid var(--color-border);">
                            <button onclick="pages.activityDetail.saveSkillScore(${activity.id}, ${student.id}, ${skill.id}, '${escapeHtml(level)}')"
                                style="width: 32px; height: 32px; border-radius: var(--radius-circle); border: 2px solid ${isSelected ? skillColor : 'var(--color-border)'}; background: ${isSelected ? skillColor : 'var(--color-background)'}; color: ${isSelected ? 'white' : 'var(--color-text-tertiary)'}; cursor: pointer; font-size: 12px; font-weight: 600;">
                                ${isSelected ? '✓' : ''}
                            </button>
                        </td>`;
                    });
                    html += '</tr>';
                });
                html += '</tbody></table></div>';
            }

            // --- Form Responses (expandable) ---
            if (sub?.formResponses?.answers?.length > 0) {
                const fr = sub.formResponses;
                html += `<div style="margin-top: var(--space-sm); padding-top: var(--space-sm); border-top: 1px solid var(--color-border);">
                    <details>
                        <summary style="cursor: pointer; font-size: var(--font-size-body-small); font-weight: 600; color: var(--color-text-secondary); user-select: none;">
                            📋 Form Responses${fr.totalScore != null ? ` — Score: ${fr.totalScore}${fr.totalPossible ? '/' + fr.totalPossible : ''}` : ''}
                        </summary>
                        <div style="margin-top: var(--space-xs); font-size: var(--font-size-body-small);">
                            ${fr.answers.map((a, idx) => `
                                <div style="padding: 6px 0; ${idx > 0 ? 'border-top: 1px solid var(--color-border);' : ''}">
                                    <div style="font-weight: 600; color: var(--color-text-secondary); margin-bottom: 2px;">${escapeHtml(a.question)}</div>
                                    <div style="color: var(--color-text-primary);">${escapeHtml(a.answer || '—')}</div>
                                    ${a.score != null ? `<div style="color: var(--color-info); margin-top: 2px;">Score: ${a.score}${a.maxPoints ? '/' + a.maxPoints : ''}</div>` : ''}
                                    ${a.autoFeedback ? `<div style="color: var(--color-text-tertiary); font-style: italic; margin-top: 2px;">${escapeHtml(a.autoFeedback)}</div>` : ''}
                                </div>
                            `).join('')}
                            ${fr.autoFeedback ? `<div style="padding: 6px 0; border-top: 1px solid var(--color-border); color: var(--color-text-tertiary); font-style: italic;">Overall: ${escapeHtml(fr.autoFeedback)}</div>` : ''}
                        </div>
                    </details>
                </div>`;
            }

            // Teacher feedback textarea
            const hasFbRub = sub?.feedback && sub.feedback.trim() !== '';
            const sentTodayRub = sentToday.has(student.id);
            html += `<div style="margin-top: var(--space-sm); padding-top: var(--space-sm); border-top: 1px solid var(--color-border);">
                <textarea id="fb-text-${student.id}" placeholder="Add feedback for ${escapeHtml(displayName(student))}..."
                    onblur="pages.activityDetail.saveFeedback(${activity.id}, ${student.id}, this.value)"
                    oninput="var b=document.getElementById('send-fb-${student.id}'); if(b && !b.textContent.startsWith('✓')) b.disabled=!this.value.trim();"
                    style="width: 100%; min-height: 50px; padding: var(--space-xs); border: 1px solid var(--color-border); border-radius: var(--radius-sm); font-size: var(--font-size-body-small); font-family: inherit; resize: vertical; box-sizing: border-box;"
                >${escapeHtml(sub?.feedback || '')}</textarea>
                ${showSendBtns ? `<div style="text-align: right; margin-top: 4px;">
                    <button id="send-fb-${student.id}" class="btn btn--secondary" style="font-size: 11px; padding: 2px 10px;"
                        onclick="pages.activityDetail.sendStudentFeedback(${activity.id}, ${student.id})"
                        ${sentTodayRub ? 'disabled' : (!hasFbRub ? 'disabled' : '')}>${sentTodayRub ? '✓ Sent' : '✉ Send'}</button>
                </div>` : ''}
                ${(() => {
                    const meRub = (sub?.raceScores || []).find(e => e.question === 'Manual Entry');
                    return `<details style="margin-top: var(--space-xs);">
                        <summary style="cursor: pointer; font-size: var(--font-size-body-small); font-weight: 600; color: var(--color-text-secondary); user-select: none;">✏️ RACE Scores</summary>
                        <div style="display: flex; gap: var(--space-sm); align-items: center; margin-top: var(--space-xs); flex-wrap: wrap;">
                            <label style="font-size: var(--font-size-body-small);">R <input type="number" min="0" max="5" step="1" id="race-r-${student.id}" value="${meRub?.R ?? ''}" style="width: 50px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); text-align: center;"></label>
                            <label style="font-size: var(--font-size-body-small);">A <input type="number" min="0" max="5" step="1" id="race-a-${student.id}" value="${meRub?.A ?? ''}" style="width: 50px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); text-align: center;"></label>
                            <label style="font-size: var(--font-size-body-small);">C <input type="number" min="0" max="5" step="1" id="race-c-${student.id}" value="${meRub?.C ?? ''}" style="width: 50px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); text-align: center;"></label>
                            <label style="font-size: var(--font-size-body-small);">E <input type="number" min="0" max="5" step="1" id="race-e-${student.id}" value="${meRub?.E ?? ''}" style="width: 50px; padding: 2px 4px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); text-align: center;"></label>
                            <button class="btn btn--primary" style="font-size: 11px; padding: 4px 10px;" onclick="pages.activityDetail.saveRaceScores(${activity.id}, ${student.id})">Save RACE Scores</button>
                        </div>
                    </details>`;
                })()}
            </div>`;

            html += '</div></details>';
        });

        container.innerHTML = html;
    },

    saveSubmission: async function(activityId, studentId, status, score) {
        try {
            const existing = await db.submissions
                .where('activityId').equals(activityId)
                .filter(s => s.studentId === studentId)
                .first();

            const data = {
                activityId: activityId,
                studentId: studentId,
                status: status || (existing?.status || 'not-started'),
                updatedAt: new Date().toISOString()
            };

            // Only update score if explicitly provided (not null)
            if (score !== null && score !== undefined) {
                data.score = score;
                data.status = 'graded';
            } else if (existing) {
                data.score = existing.score;
                data.rubricScores = existing.rubricScores;
                data.feedback = existing.feedback;
            }

            // Sprint 13.5: Set/clear gradedAt
            const oldStatus = existing?.status || 'not-started';
            if (data.status === 'graded' && oldStatus !== 'graded') {
                data.gradedAt = new Date().toISOString();
            } else if (data.status !== 'graded' && oldStatus === 'graded') {
                data.gradedAt = null;
            } else if (existing?.gradedAt) {
                data.gradedAt = existing.gradedAt;
            }

            if (existing) {
                await db.submissions.update(existing.id, data);
            } else {
                data.submittedAt = new Date().toISOString();
                await db.submissions.add(data);
            }
            driveSync.markDirty();
        } catch (err) {
            console.error('Error saving submission:', err);
            ui.showToast('Failed to save', 'error');
        }
    },

    parseRaceFeedback: function(feedbackText) {
        if (!feedbackText) return null;

        const result = {
            R: null, A: null, C: null, E: null,
            total: null, maxTotal: null,
            comments: {}
        };

        const lines = feedbackText.split('\n');
        const feedbackLines = [];
        let pastScores = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Try to match a RACE score line
            // Handles: "R (Restate): 5/5 - comment", "R: 5/5 - comment", "Restate: 5/5 - comment"
            const scoreMatch = trimmed.match(
                /^(?:(R|A|C|E)\s*(?:\([^)]*\))?|Restate|Answer|Cite(?:\/Prove)?|Explain(?:\/Examples)?)\s*:\s*(\d+)\s*\/\s*(\d+)(?:\s*[-–—]\s*(.*))?/i
            );

            if (scoreMatch) {
                // Figure out which RACE letter this is
                let letter = scoreMatch[1] ? scoreMatch[1].toUpperCase() : null;
                if (!letter) {
                    const word = trimmed.split(/\s*:/)[0].trim().toLowerCase();
                    if (word.startsWith('r')) letter = 'R';
                    else if (word.startsWith('a')) letter = 'A';
                    else if (word.startsWith('c')) letter = 'C';
                    else if (word.startsWith('e')) letter = 'E';
                }

                if (letter && 'RACE'.includes(letter)) {
                    result[letter] = parseInt(scoreMatch[2]);
                    result.comments[letter] = scoreMatch[4] ? scoreMatch[4].trim() : '';
                }
            } else if (trimmed.match(/^Total\s*(Score)?\s*:/i)) {
                // Skip total score lines — we'll calculate it ourselves
            } else if (trimmed.match(/^Feedback\s*:/i)) {
                // "Feedback:" label line — everything after is the paragraph
                const afterLabel = trimmed.replace(/^Feedback\s*:\s*/i, '');
                if (afterLabel) feedbackLines.push(afterLabel);
                pastScores = true;
            } else if (result.R !== null) {
                // We've already seen at least one score, so this is feedback text
                pastScores = true;
                feedbackLines.push(trimmed);
            }
        }

        // Only return a result if we found at least one RACE score
        if (result.R === null && result.A === null && result.C === null && result.E === null) {
            return null;
        }

        // Calculate totals from what we found
        const scored = ['R', 'A', 'C', 'E'].filter(l => result[l] !== null);
        result.total = scored.reduce((sum, l) => sum + result[l], 0);
        result.maxTotal = scored.length * 5;
        result.feedbackText = feedbackLines.join(' ').trim();

        return result;
    },

    saveFeedback: async function(activityId, studentId, feedbackText) {
        try {
            const existing = await db.submissions
                .where('activityId').equals(activityId)
                .filter(s => s.studentId === studentId)
                .first();

            const updateData = {
                feedback: feedbackText,
                updatedAt: new Date().toISOString()
            };

            // Parse RACE scores from feedback text
            const parsed = this.parseRaceFeedback(feedbackText);
            if (parsed && (parsed.R !== null || parsed.A !== null || parsed.C !== null || parsed.E !== null)) {
                const existingRace = (existing?.raceScores || []).filter(e => e.question !== 'Manual Feedback');
                existingRace.push({ question: 'Manual Feedback', ...parsed });
                updateData.raceScores = existingRace;

                // Auto-populate the RACE number inputs on screen
                const rI = document.getElementById(`race-r-${studentId}`);
                const aI = document.getElementById(`race-a-${studentId}`);
                const cI = document.getElementById(`race-c-${studentId}`);
                const eI = document.getElementById(`race-e-${studentId}`);
                if (rI && parsed.R !== null) rI.value = parsed.R;
                if (aI && parsed.A !== null) aI.value = parsed.A;
                if (cI && parsed.C !== null) cI.value = parsed.C;
                if (eI && parsed.E !== null) eI.value = parsed.E;
            }

            if (existing) {
                await db.submissions.update(existing.id, updateData);
            } else {
                await db.submissions.add({
                    activityId: activityId,
                    studentId: studentId,
                    status: 'not-started',
                    ...updateData,
                    submittedAt: new Date().toISOString()
                });
            }
            driveSync.markDirty();
        } catch (err) {
            console.error('Error saving feedback:', err);
            ui.showToast('Failed to save feedback', 'error');
        }
    },

    saveRaceScores: async function(activityId, studentId) {
        try {
            const r = parseInt(document.getElementById(`race-r-${studentId}`)?.value) || 0;
            const a = parseInt(document.getElementById(`race-a-${studentId}`)?.value) || 0;
            const c = parseInt(document.getElementById(`race-c-${studentId}`)?.value) || 0;
            const e = parseInt(document.getElementById(`race-e-${studentId}`)?.value) || 0;

            const scored = [r, a, c, e].filter(v => !isNaN(v));
            const total = scored.reduce((sum, v) => sum + v, 0);
            const maxTotal = scored.length * 5;

            const entry = {
                question: 'Manual Entry',
                R: r, A: a, C: c, E: e,
                total: total,
                maxTotal: maxTotal,
                comments: {},
                feedbackText: ''
            };

            const existing = await db.submissions
                .where('activityId').equals(activityId)
                .filter(s => s.studentId === studentId)
                .first();

            const existingRace = (existing?.raceScores || []).filter(e => e.question !== 'Manual Entry');
            existingRace.push(entry);

            if (existing) {
                await db.submissions.update(existing.id, {
                    raceScores: existingRace,
                    updatedAt: new Date().toISOString()
                });
            } else {
                await db.submissions.add({
                    activityId: activityId,
                    studentId: studentId,
                    status: 'not-started',
                    raceScores: existingRace,
                    submittedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
            }
            driveSync.markDirty();
            ui.showToast('RACE scores saved', 'success');
        } catch (err) {
            console.error('Error saving RACE scores:', err);
            ui.showToast('Failed to save RACE scores', 'error');
        }
    },

    showAttemptHistory: async function(activityId, studentId, evt) {
        const containerId = `attempt-history-${studentId}`;
        const existing = document.getElementById(containerId);
        if (existing) {
            existing.remove();
            return;
        }

        const submission = await db.submissions
            .where('activityId').equals(activityId)
            .filter(s => s.studentId === studentId)
            .first();

        if (!submission || !submission.attempts || submission.attempts.length === 0) {
            ui.showToast('No prior attempts found', 'info');
            return;
        }

        const html = submission.attempts.map(attempt => {
            const submittedStr = attempt.submittedAt ? new Date(attempt.submittedAt).toLocaleDateString() : 'N/A';
            const gradedStr = attempt.gradedAt ? new Date(attempt.gradedAt).toLocaleDateString() : '';
            const scoreStr = attempt.score !== null && attempt.score !== undefined ? ` · Score: ${attempt.score}` : '';
            const feedbackStr = attempt.feedback ? `<div style="margin-top: 2px; color: var(--color-text-tertiary);">Feedback: ${escapeHtml(attempt.feedback.substring(0, 100))}${attempt.feedback.length > 100 ? '...' : ''}</div>` : '';
            return `<div style="padding: var(--space-xs) 0; border-bottom: 1px solid var(--color-border);">
                <strong>Attempt ${attempt.attemptNumber}</strong> — Submitted: ${submittedStr}${scoreStr}${gradedStr ? ` · Graded: ${gradedStr}` : ''}
                ${feedbackStr}
            </div>`;
        }).join('');

        const container = document.createElement('div');
        container.id = containerId;
        container.style.cssText = 'margin-top: var(--space-sm); padding: var(--space-sm); background: var(--color-background-tertiary); border-radius: var(--radius-md); font-size: var(--font-size-body-small);';
        container.innerHTML = html;

        // Insert after the button's parent
        if (evt && evt.target) {
            evt.target.closest('div').after(container);
        }
    },

    pushToClassroom: async function() {
        try {
            const activity = await db.activities.get(state.selectedActivity);
            if (!activity || !activity.classroomLinks || Object.keys(activity.classroomLinks).length === 0) {
                ui.showToast('No Classroom link configured for this assignment', 'error');
                return;
            }

            const webhookUrl = localStorage.getItem('webhook_absent') || localStorage.getItem('webhook_wildcat');
            const token = localStorage.getItem('webhook_token') || '';
            if (!webhookUrl) {
                ui.showToast('No webhook URL configured', 'error');
                return;
            }

            // Get all submissions for this activity
            const submissions = await db.submissions
                .where('activityId').equals(activity.id)
                .toArray();

            // Build grades array: only include students who have a score and an email
            const allStudents = await db.students.toArray();
            const studentMap = {};
            allStudents.forEach(function(s) { studentMap[String(s.id)] = s; });

            // Load checkpoint data for blended grade calculation
            const checkpoints = await db.checkpoints.where('activityId').equals(activity.id).toArray();
            const allCompletions = await db.checkpointCompletions.toArray();

            const grades = [];
            for (const sub of submissions) {
                const student = studentMap[String(sub.studentId)];
                if (!student || !student.email) continue;

                let score = null;

                if ((activity.checkpointGradeWeight || 0) > 0 && checkpoints.length > 0) {
                    // Use blended grade calculation
                    const result = calculateFinalGrade(activity, sub.studentId, sub, checkpoints, allCompletions);
                    // Find the max points for the Classroom assignment
                    const classroomMaxPts = activity.defaultPoints || 100;
                    score = Math.round(result.finalScore * classroomMaxPts * 10) / 10;
                } else {
                    // Original scoring (no checkpoint weight)
                    const scoringType = activity.scoringType || 'complete-incomplete';

                    if (scoringType === 'points' && sub.score != null) {
                        score = sub.score;
                    } else if (scoringType === 'rubric' && sub.rubricScores && activity.rubric) {
                        const levels = activity.rubric.levels || [];
                        const criteria = activity.rubric.criteria || [];
                        let total = 0;
                        let count = 0;
                        criteria.forEach(function(c) {
                            const idx = levels.indexOf(sub.rubricScores[c.name]);
                            if (idx >= 0) {
                                total += (levels.length - 1 - idx) / (levels.length - 1);
                                count++;
                            }
                        });
                        if (count > 0) {
                            const pct = total / count;
                            const maxPts = activity.defaultPoints || 100;
                            score = Math.round(pct * maxPts * 10) / 10;
                        }
                    } else if (scoringType === 'complete-incomplete') {
                        const maxPts = activity.defaultPoints || 100;
                        if (sub.status === 'graded' || sub.status === 'submitted') {
                            score = maxPts;
                        } else {
                            score = 0;
                        }
                    }
                }

                if (score !== null) {
                    grades.push({
                        studentEmail: student.email,
                        studentName: displayName(student),
                        score: score
                    });
                }
            }

            if (grades.length === 0) {
                ui.showToast('No graded students with emails to push', 'info');
                return;
            }

            // Determine which course(s) to push to
            const links = activity.classroomLinks || {};
            const courseIds = Object.keys(links);

            if (courseIds.length === 0) {
                ui.showToast('No Classroom links configured', 'error');
                return;
            }

            let selectedCourseId;
            if (courseIds.length === 1) {
                selectedCourseId = courseIds[0];
            } else {
                // Multiple courses linked — ask which one
                const choices = courseIds.map(function(cId, i) { return (i + 1) + ': Course ' + cId; }).join('\n');
                const pick = prompt('Multiple Classroom courses linked. Enter the number to push to:\n\n' + choices);
                if (!pick) return;
                const idx = parseInt(pick) - 1;
                if (idx < 0 || idx >= courseIds.length) {
                    ui.showToast('Invalid selection', 'error');
                    return;
                }
                selectedCourseId = courseIds[idx];
            }

            const selectedCwId = links[selectedCourseId];

            if (!confirm('Push ' + grades.length + ' score(s) to Google Classroom?\n\nThis will set draft and assigned grades for the linked assignment.')) {
                return;
            }

            const btn = document.getElementById('push-classroom-btn');
            btn.disabled = true;
            btn.textContent = '🎓 Pushing...';

            const resp = await fetch(webhookUrl, {
                method: 'POST',
                body: JSON.stringify({
                    token: token,
                    action: 'push_to_classroom',
                    courseId: selectedCourseId,
                    courseWorkId: selectedCwId,
                    grades: grades
                })
            });
            const result = await resp.json();

            btn.disabled = false;
            btn.textContent = '🎓 Push to Classroom';

            if (result.status === 'success') {
                let msg = '✅ Pushed ' + result.pushed + '/' + result.total + ' scores to Classroom';
                if (result.errors && result.errors.length > 0) {
                    msg += '\n\nIssues:\n• ' + result.errors.join('\n• ');
                }
                ui.showToast(msg, result.errors && result.errors.length > 0 ? 'warning' : 'success');

                await db.notes.add({
                    entityType: 'classroom-push-log',
                    entityId: activity.id,
                    text: 'Pushed ' + result.pushed + '/' + result.total + ' scores. ' + (result.errors || []).join('; '),
                    createdAt: new Date().toISOString()
                });
            } else {
                ui.showToast('Push failed: ' + (result.message || 'Unknown error'), 'error');
            }
        } catch (err) {
            document.getElementById('push-classroom-btn').disabled = false;
            document.getElementById('push-classroom-btn').textContent = '🎓 Push to Classroom';
            ui.showToast('Error pushing to Classroom: ' + err.message, 'error');
        }
    },

    exportGradesCSV: async function(format, ferpa) {
        if (!this._data) {
            ui.showToast('No assignment loaded.', 'error');
            return;
        }

        const { activity } = this._data;

        try {
            // Gather the data we need
            const students = this._data.allStudents;
            const checkpoints = await db.checkpoints.where('activityId').equals(activity.id).toArray();
            const allCompletions = await db.checkpointCompletions.toArray();
            const submissions = await db.submissions.where('activityId').equals(activity.id).toArray();
            const submissionMap = new Map(submissions.map(s => [s.studentId, s]));

            const maxPoints = activity.defaultPoints || 100;
            let rows = [];

            students.forEach(student => {
                const sub = submissionMap.get(student.id);
                let score = '';

                if (sub) {
                    if ((activity.checkpointGradeWeight || 0) > 0 && checkpoints.length > 0) {
                        const result = calculateFinalGrade(activity, student.id, sub, checkpoints, allCompletions);
                        score = Math.round(result.finalScore * maxPoints * 10) / 10;
                    } else {
                        const scoringType = activity.scoringType || 'complete-incomplete';
                        if (scoringType === 'points' && sub.score != null) {
                            score = sub.score;
                        } else if (scoringType === 'rubric' && sub.rubricScores && activity.rubric) {
                            const levels = activity.rubric.levels || [];
                            const criteria = activity.rubric.criteria || [];
                            let total = 0, count = 0;
                            criteria.forEach(c => {
                                const idx = levels.indexOf(sub.rubricScores[c.name]);
                                if (idx >= 0) {
                                    total += (levels.length - 1 - idx) / (levels.length - 1);
                                    count++;
                                }
                            });
                            if (count > 0) score = Math.round((total / count) * maxPoints * 10) / 10;
                        } else if (scoringType === 'complete-incomplete') {
                            score = (sub.status === 'graded' || sub.status === 'submitted') ? maxPoints : 0;
                        }
                    }
                }

                rows.push({
                    firstName: student.firstName || '',
                    lastName: student.lastName || '',
                    email: student.email || '',
                    score: score,
                    status: sub ? sub.status : 'not-started',
                    anonId: student.anonId || ''
                });
            });

            // Sort by last name, first name
            rows.sort((a, b) => sortByStudentName(a, b));

            let csv = '';

            if (format === 'classroom') {
                if (ferpa) {
                    csv = 'Anonymous ID,Grade\n';
                    rows.forEach(r => {
                        csv += `${csvEscape(r.anonId)},${csvEscape(r.score)}\n`;
                    });
                } else {
                    csv = 'First Name,Last Name,Email Address,Grade\n';
                    rows.forEach(r => {
                        if (r.email) {
                            csv += `${csvEscape(r.firstName)},${csvEscape(r.lastName)},${csvEscape(r.email)},${csvEscape(r.score)}\n`;
                        }
                    });
                }
            } else if (format === 'progressbook') {
                if (ferpa) {
                    csv = 'Anonymous ID,Score,Max Points,Status\n';
                    rows.forEach(r => {
                        csv += `${csvEscape(r.anonId)},${csvEscape(r.score)},${csvEscape(maxPoints)},${csvEscape(r.status)}\n`;
                    });
                } else {
                    csv = 'Last Name,First Name,Score,Max Points,Status\n';
                    rows.forEach(r => {
                        csv += `${csvEscape(r.lastName)},${csvEscape(r.firstName)},${csvEscape(r.score)},${csvEscape(maxPoints)},${csvEscape(r.status)}\n`;
                    });
                }
            }

            const suffix = ferpa ? 'FERPA' : format;
            const safeName = (activity.name || 'Assignment').replace(/[^a-zA-Z0-9_-]/g, '_');
            downloadCSV(csv, `Grades_${suffix}_${safeName}`);
            ui.showToast(`Grades exported (${ferpa ? 'FERPA-safe' : format === 'classroom' ? 'Google Classroom' : 'Progressbook'} format).`, 'success');

        } catch (error) {
            console.error('Grade export error:', error);
            ui.showToast('Failed to export grades.', 'error');
        }
    },

    sendAllFeedback: async function() {
        try {
            const activity = await db.activities.get(state.selectedActivity);
            if (!activity) return;

            const webhookUrl = localStorage.getItem('webhook_absent') || localStorage.getItem('webhook_wildcat');
            const token = localStorage.getItem('webhook_token') || '';
            if (!webhookUrl) {
                ui.showToast('No webhook URL configured', 'error');
                return;
            }

            // Get all submissions with feedback for this activity
            const submissions = await db.submissions
                .where('activityId').equals(activity.id)
                .toArray();

            const withFeedback = submissions.filter(s => s.feedback && s.feedback.trim() !== '');
            if (withFeedback.length === 0) {
                ui.showToast('No feedback to send', 'info');
                return;
            }

            // Load checkpoint data once — used for blended grade calc and completion counts
            const checkpoints = await db.checkpoints
                .where('activityId').equals(activity.id)
                .toArray();
            const allCompletions = await db.checkpointCompletions.toArray();
            const maxPoints = activity.defaultPoints || 100;
            const cpWeight = activity.checkpointGradeWeight || 0;

            // Check which students already received feedback today
            const todayStr = getTodayString();
            const existingLogs = await db.notes
                .where('entityType').equals('feedback-log')
                .toArray();
            const sentToday = new Set(
                existingLogs
                    .filter(n => n.createdAt && n.createdAt.startsWith(todayStr))
                    .map(n => n.entityId)
            );

            // Load students for names and emails
            const students = await db.students.toArray();
            const studentMap = new Map(students.map(s => [s.id, s]));

            // Build the feedbacks array, skipping already-sent and no-email students
            const feedbacks = [];
            const skippedNoEmail = [];
            const skippedAlreadySent = [];

            for (const sub of withFeedback) {
                const student = studentMap.get(sub.studentId);
                if (!student) continue;

                if (sentToday.has(sub.studentId)) {
                    skippedAlreadySent.push(displayName(student));
                    continue;
                }

                if (!student.email || student.email.trim() === '') {
                    skippedNoEmail.push(displayName(student));
                    continue;
                }

                const entry = {
                    studentName: displayName(student),
                    studentEmail: student.email,
                    assignmentName: activity.name,
                    date: todayStr,
                    teacherFeedback: sub.feedback
                };

                // Compute the final grade using the same logic as pushToClassroom.
                // finalScore is a 0–1 fraction; gradePoints is the raw points out of maxPoints.
                const gradeResult = calculateFinalGrade(activity, sub.studentId, sub, checkpoints, allCompletions);
                const finalPct = gradeResult.finalScore;
                entry.gradePercent = Math.round(finalPct * 1000) / 10;  // e.g., 85.0
                entry.gradePoints = Math.round(finalPct * maxPoints * 10) / 10;  // e.g., 42.5
                entry.maxPoints = maxPoints;

                // Rubric breakdown — send criteria/levels/scores so Code.gs can render per-criterion rows
                if (activity.scoringType === 'rubric' && activity.rubric) {
                    entry.rubric = {
                        levels: activity.rubric.levels || [],
                        criteria: (activity.rubric.criteria || []).map(c => c.name),
                        scores: sub.rubricScores || {}
                    };
                }

                // Checkpoint completion count — only when checkpoints contribute to the grade
                if (cpWeight > 0 && checkpoints.length > 0) {
                    const completedCount = allCompletions.filter(c =>
                        String(c.studentId) === String(sub.studentId) &&
                        c.completed &&
                        checkpoints.some(cp => cp.id === c.checkpointId)
                    ).length;
                    entry.checkpointsCompleted = completedCount;
                    entry.checkpointsTotal = checkpoints.length;
                }

                // Include form responses if available (rendered AFTER rubric breakdown in email)
                if (sub.formResponses?.answers?.length > 0) {
                    entry.answers = sub.formResponses.answers;
                    entry.formTotalScore = sub.formResponses.totalScore;
                    entry.formTotalPossible = sub.formResponses.totalPossible;
                }

                feedbacks.push({ ...entry, studentId: sub.studentId });
            }

            if (feedbacks.length === 0) {
                let msg = 'No feedback emails to send.';
                if (skippedAlreadySent.length > 0) msg += ` ${skippedAlreadySent.length} already sent today.`;
                if (skippedNoEmail.length > 0) msg += ` ${skippedNoEmail.length} missing email.`;
                ui.showToast(msg, 'info');
                return;
            }

            // Confirm before sending
            if (!confirm(`Send feedback emails to ${feedbacks.length} student(s)?`)) return;

            // Send to webhook
            const response = await fetch(webhookUrl, {
                method: 'POST',
                body: JSON.stringify({
                    action: 'send_feedback',
                    feedbacks: feedbacks,
                    token: token
                })
            });
            const result = await response.json();

            if (result.status === 'success') {
                // Log each sent email
                for (const fb of feedbacks) {
                    await db.notes.add({
                        entityType: 'feedback-log',
                        entityId: fb.studentId,
                        content: `Feedback sent for "${activity.name}" on ${todayStr}`,
                        createdAt: new Date().toISOString()
                    });
                }

                let msg = `✉ Sent feedback to ${result.sent} student(s)`;
                if (skippedAlreadySent.length > 0) msg += ` (${skippedAlreadySent.length} already sent)`;
                if (skippedNoEmail.length > 0) msg += ` (${skippedNoEmail.length} no email)`;
                ui.showToast(msg, 'success');

                // Re-render using cached student list
                const reloadActivity = await db.activities.get(activity.id);
                this.renderSubmissions(reloadActivity, this._data.allStudents);
            } else {
                console.error('Feedback email error:', result);
                ui.showToast('Failed to send feedback emails — check console', 'error');
            }
        } catch (err) {
            console.error('Send feedback failed:', err);
            ui.showToast('Failed to send feedback — check console', 'error');
        }
    },

    sendStudentFeedback: async function(activityId, studentId) {
        const btn = document.getElementById('send-fb-' + studentId);
        try {
            const activity = await db.activities.get(activityId);
            if (!activity) return;

            const webhookUrl = localStorage.getItem('webhook_absent') || localStorage.getItem('webhook_wildcat');
            const token = localStorage.getItem('webhook_token') || '';
            if (!webhookUrl) {
                ui.showToast('No webhook URL configured', 'error');
                return;
            }

            // Load the student's submission
            const sub = await db.submissions
                .where('activityId').equals(activityId)
                .filter(s => s.studentId === studentId)
                .first();

            if (!sub || !sub.feedback || sub.feedback.trim() === '') {
                ui.showToast('No feedback written for this student', 'info');
                return;
            }

            // Check if already sent today
            const todayStr = getTodayString();
            const existingLogs = await db.notes
                .where('entityType').equals('feedback-log')
                .filter(n => n.entityId === studentId && n.createdAt && n.createdAt.startsWith(todayStr))
                .toArray();
            if (existingLogs.length > 0) {
                const student = await db.students.get(studentId);
                ui.showToast('Feedback already sent to ' + displayName(student) + ' today', 'info');
                return;
            }

            // Load student record
            const student = await db.students.get(studentId);
            if (!student) return;
            if (!student.email || student.email.trim() === '') {
                ui.showToast(displayName(student) + ' has no email address', 'error');
                return;
            }

            // Build feedback entry — identical structure to sendAllFeedback
            const maxPoints = activity.defaultPoints || 100;
            const cpWeight = activity.checkpointGradeWeight || 0;
            const checkpoints = await db.checkpoints.where('activityId').equals(activityId).toArray();
            const allCompletions = await db.checkpointCompletions.toArray();

            const entry = {
                studentName: displayName(student),
                studentEmail: student.email,
                assignmentName: activity.name,
                date: todayStr,
                teacherFeedback: sub.feedback
            };

            const gradeResult = calculateFinalGrade(activity, studentId, sub, checkpoints, allCompletions);
            const finalPct = gradeResult.finalScore;
            entry.gradePercent = Math.round(finalPct * 1000) / 10;
            entry.gradePoints = Math.round(finalPct * maxPoints * 10) / 10;
            entry.maxPoints = maxPoints;

            if (activity.scoringType === 'rubric' && activity.rubric) {
                entry.rubric = {
                    levels: activity.rubric.levels || [],
                    criteria: (activity.rubric.criteria || []).map(c => c.name),
                    scores: sub.rubricScores || {}
                };
            }

            if (cpWeight > 0 && checkpoints.length > 0) {
                const completedCount = allCompletions.filter(c =>
                    String(c.studentId) === String(studentId) &&
                    c.completed &&
                    checkpoints.some(cp => cp.id === c.checkpointId)
                ).length;
                entry.checkpointsCompleted = completedCount;
                entry.checkpointsTotal = checkpoints.length;
            }

            if (sub.formResponses?.answers?.length > 0) {
                entry.answers = sub.formResponses.answers;
                entry.formTotalScore = sub.formResponses.totalScore;
                entry.formTotalPossible = sub.formResponses.totalPossible;
            }

            // Disable button while sending
            if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

            const response = await fetch(webhookUrl, {
                method: 'POST',
                body: JSON.stringify({
                    action: 'send_feedback',
                    feedbacks: [entry],
                    token: token
                })
            });
            const result = await response.json();

            if (result.status === 'success') {
                await db.notes.add({
                    entityType: 'feedback-log',
                    entityId: studentId,
                    content: 'Feedback sent for "' + activity.name + '" on ' + todayStr,
                    createdAt: new Date().toISOString()
                });

                ui.showToast('✉ Feedback sent to ' + displayName(student), 'success');
                if (btn) { btn.textContent = '✓ Sent'; btn.disabled = true; }
            } else {
                console.error('Feedback email error:', result);
                ui.showToast('Failed to send feedback — check console', 'error');
                if (btn) { btn.textContent = '✉ Send'; btn.disabled = false; }
            }
        } catch (err) {
            console.error('Send student feedback failed:', err);
            ui.showToast('Failed to send feedback — check console', 'error');
            if (btn) { btn.textContent = '✉ Send'; btn.disabled = false; }
        }
    },

    saveRubricScore: async function(activityId, studentId, criterionName, level) {
        try {
            const existing = await db.submissions
                .where('activityId').equals(activityId)
                .filter(s => s.studentId === studentId)
                .first();

            let rubricScores = existing?.rubricScores || {};
            // Toggle: if already selected, deselect
            if (rubricScores[criterionName] === level) {
                delete rubricScores[criterionName];
            } else {
                rubricScores[criterionName] = level;
            }

            // Auto-set to graded if all criteria have been scored
            const activityForRubric = await db.activities.get(activityId);
            const allCriteria = activityForRubric?.rubric?.criteria || [];
            const allScored = allCriteria.length > 0 && allCriteria.every(c => rubricScores[c.name]);
            
            const newStatus = allScored ? 'graded' : (existing?.status || 'in-progress');
            const oldStatus = existing?.status || 'not-started';
            const data = {
                activityId: activityId,
                studentId: studentId,
                rubricScores: rubricScores,
                status: newStatus,
                score: existing?.score || null,
                feedback: existing?.feedback || '',
                updatedAt: new Date().toISOString()
            };
            // Sprint 13.5: Set/clear gradedAt on status transition
            if (newStatus === 'graded' && oldStatus !== 'graded') {
                data.gradedAt = new Date().toISOString();
            } else if (newStatus !== 'graded' && oldStatus === 'graded') {
                data.gradedAt = null;
            } else if (existing?.gradedAt) {
                data.gradedAt = existing.gradedAt;
            }

            if (existing) {
                await db.submissions.update(existing.id, data);
            } else {
                data.submittedAt = new Date().toISOString();
                await db.submissions.add(data);
            }
            driveSync.markDirty();
            // Re-render using cached student list (sort is applied inside renderSubmissions)
            const activityReload = await db.activities.get(activityId);
            this.renderSubmissions(activityReload, this._data.allStudents);

        } catch (err) {
            console.error('Error saving rubric score:', err);
            ui.showToast('Failed to save', 'error');
        }
    },

    saveFormMapping: async function(activityId) {
        try {
            const activity = await db.activities.get(activityId);
            if (!activity || !activity.rubric || !activity.rubric.criteria) return;

            const criteria = activity.rubric.criteria;
            const fromInputs = document.querySelectorAll('.form-mapping-from');
            const toInputs = document.querySelectorAll('.form-mapping-to');

            fromInputs.forEach(input => {
                const idx = parseInt(input.dataset.criterionIndex);
                if (idx >= 0 && idx < criteria.length) {
                    criteria[idx].formQuestionFrom = parseInt(input.value) || null;
                }
            });
            toInputs.forEach(input => {
                const idx = parseInt(input.dataset.criterionIndex);
                if (idx >= 0 && idx < criteria.length) {
                    criteria[idx].formQuestionTo = parseInt(input.value) || null;
                }
            });

            await db.activities.update(activityId, {
                rubric: activity.rubric,
                updatedAt: new Date().toISOString()
            });
            driveSync.markDirty();
            ui.showToast('Form → Rubric mapping saved!', 'success');
        } catch (err) {
            console.error('Failed to save form mapping:', err);
            ui.showToast('Failed to save mapping', 'error');
        }
    },

    autoMapFormScoresToRubric: async function(activityId) {
        try {
            const activity = await db.activities.get(activityId);
            if (!activity || activity.scoringType !== 'rubric') return 0;
            if (!activity.rubric || !activity.rubric.criteria || !activity.rubric.levels) return 0;

            const criteria = activity.rubric.criteria;
            const levels = activity.rubric.levels; // e.g., ['5', '4', '3', '2', '1']

            // Check if mapping is configured
            const hasMappings = criteria.some(c => c.formQuestionFrom != null);
            if (!hasMappings) return 0;

            // Parse levels as numbers for comparison, keep originals for storage
            const levelNums = levels.map(l => parseFloat(l)).filter(n => !isNaN(n));
            const isNumericLevels = levelNums.length === levels.length;

            const submissions = await db.submissions
                .where('activityId').equals(activityId)
                .toArray();

            let mapped = 0;
            for (const sub of submissions) {
                if (!sub.formResponses || !sub.formResponses.answers) continue;

                const existingScores = sub.rubricScores || {};
                // Don't skip already-scored — re-evaluate if form data might have higher scores

                const answers = sub.formResponses.answers;
                const newScores = { ...existingScores };
                let anyMapped = false;

                for (const criterion of criteria) {
                    if (criterion.formQuestionFrom == null || criterion.formQuestionTo == null) continue;

                    const from = criterion.formQuestionFrom - 1;
                    const to = criterion.formQuestionTo - 1;
                    if (from < 0 || to < 0 || from >= answers.length) continue;

                    let totalScore = 0;
                    let hasAnyScore = false;
                    for (let i = from; i <= to && i < answers.length; i++) {
                        if (answers[i].score != null) {
                            totalScore += answers[i].score;
                            hasAnyScore = true;
                        }
                    }

                    if (!hasAnyScore) continue;

                    // Find the matching level for this score
                    let newLevelValue = null;
                    if (isNumericLevels) {
                        let bestLevel = levels[levels.length - 1];
                        let bestDiff = Infinity;
                        for (let i = 0; i < levels.length; i++) {
                            const diff = Math.abs(levelNums[i] - totalScore);
                            if (diff < bestDiff) {
                                bestDiff = diff;
                                bestLevel = levels[i];
                            }
                        }
                        newLevelValue = bestLevel;
                    } else {
                        const pct = totalScore / (totalMax || 1);
                        let levelIndex;
                        if (levels.length === 4) {
                            if (pct >= 0.9) levelIndex = 0;
                            else if (pct >= 0.7) levelIndex = 1;
                            else if (pct >= 0.5) levelIndex = 2;
                            else levelIndex = 3;
                        } else if (levels.length === 3) {
                            if (pct >= 0.8) levelIndex = 0;
                            else if (pct >= 0.5) levelIndex = 1;
                            else levelIndex = 2;
                        } else if (levels.length === 2) {
                            levelIndex = pct >= 0.7 ? 0 : 1;
                        } else {
                            levelIndex = Math.min(levels.length - 1, Math.floor((1 - pct) * levels.length));
                        }
                        newLevelValue = levels[levelIndex];
                    }

                    if (!newLevelValue) continue;

                    // Only overwrite if no existing score OR new score is higher
                    const existingLevel = newScores[criterion.name];
                    if (existingLevel) {
                        const existingNum = parseFloat(existingLevel);
                        const newNum = parseFloat(newLevelValue);
                        if (!isNaN(existingNum) && !isNaN(newNum)) {
                            if (newNum <= existingNum) continue; // keep existing higher score
                        }
                    }

                    newScores[criterion.name] = newLevelValue;
                    anyMapped = true;
                }

                if (anyMapped) {
                    const allScored = criteria.every(c => newScores[c.name]);
                    const newStatus = allScored ? 'graded' : sub.status;
                    const updateData = {
                        rubricScores: newScores,
                        status: newStatus,
                        updatedAt: new Date().toISOString()
                    };
                    // Sprint 13.5: Set gradedAt when auto-map completes grading
                    if (newStatus === 'graded' && sub.status !== 'graded') {
                        updateData.gradedAt = new Date().toISOString();
                    }
                    await db.submissions.update(sub.id, updateData);
                    mapped++;
                }
            }

            if (mapped > 0) {
                console.log(`📊 Auto-mapped rubric scores for ${mapped} student(s) on "${activity.name}"`);
            }
            return mapped;
        } catch (err) {
            console.error('Auto-map rubric scores failed:', err);
            return 0;
        }
    },

    saveSkillScore: async function(activityId, studentId, skillId, level) {
        try {
            const existing = await db.submissions
                .where('activityId').equals(activityId)
                .filter(s => s.studentId === studentId)
                .first();

            let skillScores = existing?.skillScores || {};
            const key = String(skillId);
            // Toggle: if already selected, deselect
            if (skillScores[key] === level) {
                delete skillScores[key];
            } else {
                skillScores[key] = level;
            }

            const data = {
                activityId: activityId,
                studentId: studentId,
                skillScores: skillScores,
                status: existing?.status || 'in-progress',
                rubricScores: existing?.rubricScores || {},
                score: existing?.score || null,
                feedback: existing?.feedback || '',
                updatedAt: new Date().toISOString()
            };

            if (existing) {
                await db.submissions.update(existing.id, data);
            } else {
                data.submittedAt = new Date().toISOString();
                await db.submissions.add(data);
            }
            driveSync.markDirty();
            // Re-render
            const activity = await db.activities.get(activityId);
            const allStudents = this._data?.allStudents || [];
            this.renderSubmissions(activity, allStudents);

        } catch (err) {
            console.error('Error saving skill score:', err);
            ui.showToast('Failed to save', 'error');
        }
    },
};