// ============================================
// AUTO-TASKS ENGINE
// Generates tasks automatically based on data.
// Runs on dashboard load and after key actions.
// ============================================

// ============================================
// ALERTS ENGINE (Live Status Board - auto-resolving)
// ============================================
// Alerts represent CONDITIONS that are currently true.
// They auto-delete when the condition clears.
// They do NOT go into the Tasks list.
const alertsEngine = {
    async refresh() {
        try {
            const now = new Date();
            const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

            // Gather all data we need
            const activities = excludeDeleted(await db.activities.toArray()).filter(a => a.status === 'active');
            const allCheckpoints = await db.checkpoints.toArray();
            const allCompletions = await db.checkpointCompletions.toArray();
            const allTeamMembers = await db.teamMembers.toArray();
            const allStudents = excludeDeleted(await db.students.toArray()).filter(s => (s.status || 'active') === 'active');
            const studentMap = new Map(allStudents.map(s => [s.id, s]));
            const allTeams = excludeDeleted(await db.teams.toArray());
            const periodMap = await db.settings.get('period-year-map');
            const classPeriodsMap = periodMap?.value || {};
            const activeYear = await getActiveSchoolYear();
            const allEnrollments = await db.enrollments.toArray();

            // Get today's absences (to EXCLUDE absent students from checkpoint alerts)
            const todayAttendance = await db.attendance.where('date').equals(todayStr).toArray();
            const absentTodayStudentIds = new Set(
                todayAttendance.filter(a => a.status === 'absent' && a.period !== 'wildcat').map(a => parseInt(a.studentId) || a.studentId)
            );

            // Get all submissions — students who have submitted or been graded don't need alerts
            const allSubmissions = await db.submissions.toArray();
            // Helper: returns true if this student has submitted/graded for this activity
            const hasSubmitted = (studentId, activityId) => {
                const sub = allSubmissions.find(s => s.studentId === studentId && s.activityId === activityId);
                return sub && (sub.status === 'submitted' || sub.status === 'graded');
            };

            // Build fresh alerts list
            const freshAlerts = [];

            // --- ALERT TYPE 1: Students behind their team on checkpoints ---
            for (const activity of activities) {
                const checkpoints = allCheckpoints.filter(cp => cp.activityId === activity.id).sort((a, b) => a.number - b.number);
                if (checkpoints.length === 0) continue;
                const teams = allTeams.filter(t => t.classId === activity.classId);

                for (const team of teams) {
                    const members = allTeamMembers.filter(tm => tm.teamId === team.id)
                        .map(tm => tm.studentId).filter(id => studentMap.has(id));
                    if (members.length < 2) continue;

                    // Team pace = highest checkpoint where >50% complete
                    let teamPace = 0;
                    for (const cp of checkpoints) {
                        const doneCount = members.filter(sid =>
                            allCompletions.some(c => c.checkpointId === cp.id && c.studentId === sid && c.completed)
                        ).length;
                        if (doneCount > members.length / 2) teamPace = cp.number;
                    }
                    if (teamPace === 0) continue;

                    for (const studentId of members) {
                        // Skip students who are absent today — they get handled by absence follow-up tasks
                        if (absentTodayStudentIds.has(studentId)) continue;
                        // Skip students who have already submitted/been graded — grade reflects what they did
                        if (hasSubmitted(studentId, activity.id)) continue;

                        let studentHighest = 0;
                        for (const cp of checkpoints) {
                            if (allCompletions.some(c => c.checkpointId === cp.id && c.studentId === studentId && c.completed)) {
                                studentHighest = cp.number;
                            }
                        }
                        if (studentHighest < teamPace) {
                            const student = studentMap.get(studentId);
                            if (!student) continue;
                            freshAlerts.push({
                                alertKey: `cp-behind-${studentId}-${activity.id}`,
                                type: 'checkpoint',
                                title: `${displayName(student)} is behind ${team.name}`,
                                detail: `At Checkpoint ${studentHighest}, team is at ${teamPace} in ${activity.name}`,
                                linkedEntityType: 'student',
                                linkedEntityId: studentId
                            });
                        }
                    }
                }
            }

            // --- ALERT TYPE 2: Teams behind other teams on activities ---
            for (const activity of activities) {
                const checkpoints = allCheckpoints.filter(cp => cp.activityId === activity.id).sort((a, b) => a.number - b.number);
                if (checkpoints.length === 0) continue;
                const teams = allTeams.filter(t => t.classId === activity.classId);
                if (teams.length < 2) continue;

                // Determine highest "expected" checkpoint
                let highestExpected = 0;
                for (const cp of checkpoints) {
                    const isPastSuggestedDate = cp.suggestedDate && cp.suggestedDate <= todayStr;
                    let anyTeamCompleted = false;
                    for (const team of teams) {
                        const members = allTeamMembers.filter(tm => tm.teamId === team.id)
                            .map(tm => tm.studentId).filter(id => studentMap.has(id));
                        if (members.length === 0) continue;
                        const doneCount = members.filter(sid =>
                            allCompletions.some(c => c.checkpointId === cp.id && c.studentId === sid && c.completed)
                        ).length;
                        if (doneCount > members.length / 2) { anyTeamCompleted = true; break; }
                    }
                    if (isPastSuggestedDate && anyTeamCompleted) highestExpected = cp.number;
                }
                if (highestExpected === 0) continue;

                for (const team of teams) {
                    const members = allTeamMembers.filter(tm => tm.teamId === team.id)
                        .map(tm => tm.studentId).filter(id => studentMap.has(id));
                    if (members.length === 0) continue;
                    // Skip if all team members have submitted/been graded
                    if (members.every(sid => hasSubmitted(sid, activity.id))) continue;
                    let teamHighest = 0;
                    for (const cp of checkpoints) {
                        const doneCount = members.filter(sid =>
                            allCompletions.some(c => c.checkpointId === cp.id && c.studentId === sid && c.completed)
                        ).length;
                        if (doneCount > members.length / 2) teamHighest = cp.number;
                    }
                    if (teamHighest < highestExpected) {
                        freshAlerts.push({
                            alertKey: `team-behind-${team.id}-${activity.id}`,
                            type: 'team',
                            title: `${team.name} is behind`,
                            detail: `At Checkpoint ${teamHighest}, should be at ${highestExpected} in ${activity.name}`,
                            linkedEntityType: 'team',
                            linkedEntityId: team.id
                        });
                    }
                }
            }

            // --- ALERT TYPE 3: Students with incomplete checkpoints on past-due activities ---
            const overdueActivities = excludeDeleted(await db.activities.toArray())
                .filter(a => a.status === 'active' && a.endDate && a.endDate < todayStr);

            for (const activity of overdueActivities) {
                const activityCheckpoints = allCheckpoints.filter(cp => cp.activityId === activity.id);
                if (activityCheckpoints.length === 0) continue;

                const periodsForClass = Object.entries(classPeriodsMap)
                    .filter(([period, classId]) => parseInt(classId) === activity.classId)
                    .map(([period]) => period);
                const enrolledStudentIds = new Set(
                    allEnrollments
                        .filter(e => periodsForClass.includes(String(e.period)) && (!e.schoolYear || e.schoolYear === activeYear))
                        .map(e => e.studentId)
                );
                const classStudents = allStudents.filter(s => s.classId === activity.classId || enrolledStudentIds.has(s.id));

                for (const student of classStudents) {
                    // Skip absent students
                    if (absentTodayStudentIds.has(student.id)) continue;
                    // Skip students who have submitted/been graded — grade reflects what they did
                    if (hasSubmitted(student.id, activity.id)) continue;
                    const completedCount = activityCheckpoints.filter(cp =>
                        allCompletions.some(c => c.checkpointId === cp.id && c.studentId === student.id && c.completed)
                    ).length;
                    if (completedCount < activityCheckpoints.length) {
                        const remaining = activityCheckpoints.length - completedCount;
                        freshAlerts.push({
                            alertKey: `overdue-${student.id}-${activity.id}`,
                            type: 'overdue',
                            title: `${displayName(student)} — ${activity.name} overdue`,
                            detail: `${remaining} incomplete checkpoint${remaining > 1 ? 's' : ''} (due ${activity.endDate})`,
                            linkedEntityType: 'student',
                            linkedEntityId: student.id
                        });
                    }
                }
            }

            // --- SYNC TO DB: Replace all alerts with fresh ones ---
            await db.alerts.clear();
            if (freshAlerts.length > 0) {
                const toStore = freshAlerts.map(a => ({
                    ...a,
                    createdAt: new Date().toISOString()
                }));
                await db.alerts.bulkAdd(toStore);
            }
            console.log(`📡 Alerts: ${freshAlerts.length} active alert(s)`);
        } catch (err) {
            console.error('Alerts refresh failed:', err);
        }
    }
};


// ============================================
// AUTO-TASKS (Actionable items — persist until you act)
// ============================================
// Now only generates: absence follow-up tasks, low inventory, overdue checkouts.
// Checkpoint/team/overdue-assignment alerts have moved to alertsEngine.
const autoTasks = {
    async generate() {
        try {
            const now = new Date();
            const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const existingTasks = await db.tasks.toArray();
            const existingAutoKeys = new Set(
                existingTasks.filter(t => t.type === 'auto' && t.autoKey).map(t => t.autoKey)
            );
            const completedAutoKeys = new Set(
                existingTasks.filter(t => t.type === 'auto' && t.autoKey && t.completed).map(t => t.autoKey)
            );
            const dismissedSetting = await db.settings.get('dismissed-auto-tasks');
            const dismissedKeys = dismissedSetting ? dismissedSetting.value : [];
            const dismissedAutoKeys = new Set(dismissedKeys);

            const tasksToAdd = [];
            const shouldAdd = (key) => !existingAutoKeys.has(key) && !dismissedAutoKeys.has(key);

            // --- CHECK 1: Low inventory ---
            await this.checkLowInventory(tasksToAdd, shouldAdd);

            // --- CHECK 2: Overdue checkouts ---
            await this.checkOverdueCheckouts(tasksToAdd, shouldAdd, todayStr);

            // --- CHECK 3: Absence follow-up tasks ---
            await this.generateAbsenceFollowUps(todayStr, existingTasks);

            // --- CHECK 4: Grading needed (submitted but ungraded) ---
            await this.checkGradingNeeded(existingTasks);

            // --- Initialize submissions for active assignments ---
            await this.initializeSubmissions();

            // Add all new tasks
            if (tasksToAdd.length > 0) {
                await db.tasks.bulkAdd(tasksToAdd);
                console.log(`✅ Auto-tasks: generated ${tasksToAdd.length} new task(s)`);
            }
        } catch (err) {
            console.error('Auto-tasks generation failed:', err);
        }
    },

    // ---- Absence Follow-Up System ----
    // Creates a task on the FIRST day of absence, UPDATES it on consecutive days.
    // Excludes Wildcat period. Never auto-deletes — only cleared by teacher.
    async generateAbsenceFollowUps(todayStr, existingTasks) {
        try {
            const allStudents = excludeDeleted(await db.students.toArray())
                .filter(s => (s.status || 'active') === 'active');
            const studentMap = new Map(allStudents.map(s => [s.id, s]));

            // Get today's attendance — only non-wildcat periods
            const todayAttendance = await db.attendance.where('date').equals(todayStr).toArray();
            const absentToday = todayAttendance.filter(a => a.status === 'absent' && a.period !== 'wildcat');
            if (absentToday.length === 0) return;

            // Unique students absent today (across any non-wildcat period)
            const absentStudentIds = [...new Set(absentToday.map(a => parseInt(a.studentId) || a.studentId))];

            // Gather what each student missed today (activities with checkpoints completed by teammates)
            const activities = excludeDeleted(await db.activities.toArray()).filter(a => a.status === 'active');
            const allCheckpoints = await db.checkpoints.toArray();
            const allCompletions = await db.checkpointCompletions.toArray();
            const allTeamMembers = await db.teamMembers.toArray();
            const allTeams = excludeDeleted(await db.teams.toArray());
            const periodMap = await db.settings.get('period-year-map');
            const classPeriodsMap = periodMap?.value || {};
            const niDays = await getActiveNonInstructionalDays();

            // Build "what was missed" per student
            const missedWork = new Map(); // studentId -> array of strings

            for (const activity of activities) {
                const checkpoints = allCheckpoints.filter(cp => cp.activityId === activity.id).sort((a, b) => a.number - b.number);
                if (checkpoints.length === 0) continue;

                const periodsForClass = Object.entries(classPeriodsMap)
                    .filter(([period, classId]) => parseInt(classId) === activity.classId)
                    .map(([period]) => period);

                const teams = allTeams.filter(t => t.classId === activity.classId);

                // Find completions made today
                const todayCompletions = allCompletions.filter(c =>
                    c.completed && c.createdAt && c.createdAt.startsWith(todayStr)
                );
                const completedTodayCpIds = new Set(todayCompletions.map(c => c.checkpointId));

                for (const team of teams) {
                    const members = allTeamMembers.filter(tm => tm.teamId === team.id)
                        .map(tm => tm.studentId).filter(id => studentMap.has(id));

                    // Which checkpoints did this team complete today?
                    const teamCpsToday = checkpoints.filter(cp =>
                        completedTodayCpIds.has(cp.id) &&
                        todayCompletions.some(c => c.checkpointId === cp.id && members.includes(c.studentId))
                    );
                    if (teamCpsToday.length === 0) continue;

                    for (const studentId of members) {
                        if (!absentStudentIds.includes(studentId)) continue;
                        // Check this student was absent in a period for this class
                        const wasAbsentForClass = periodsForClass.some(period =>
                            absentToday.some(a => (parseInt(a.studentId) || a.studentId) === studentId && a.period === period)
                        );
                        if (!wasAbsentForClass) continue;

                        const cpNumbers = teamCpsToday.map(cp => `CP${cp.number}`).join(', ');
                        const dayPos = (activity.startDate && activity.endDate)
                            ? getSchoolDayPosition(todayStr, activity.startDate, activity.endDate, niDays)
                            : null;
                        const dayLabel = dayPos ? ` (Day ${dayPos.currentDay} of ${dayPos.totalDays})` : '';
                        if (!missedWork.has(studentId)) missedWork.set(studentId, []);
                        missedWork.get(studentId).push(`${activity.name}${dayLabel}: ${cpNumbers}`);
                    }
                }
            }

            // For each absent student, create or update their absence follow-up task
            for (const studentId of absentStudentIds) {
                const student = studentMap.get(studentId);
                if (!student) continue;

                // The autoKey for absence follow-ups uses a STABLE key per student (no date)
                // so consecutive absences UPDATE the same task
                const absenceKey = `absence-followup-${studentId}`;

                // Check for existing absence follow-up task for this student (pending OR completed)
                const existingTask = existingTasks.find(t =>
                    t.autoKey === absenceKey
                );

                const missedItems = missedWork.get(studentId) || [];
                const missedStr = missedItems.length > 0 ? ` | Missed: ${missedItems.join('; ')}` : '';

                if (existingTask) {
                    if (existingTask.completed) {
                        // Completed task exists. If today is already in its dates, skip (don't resurrect).
                        // If today is a NEW absence, delete the stale completed task and fall through to create fresh.
                        if (existingTask.absenceDates && existingTask.absenceDates.includes(todayStr)) {
                            continue;
                        }
                        await db.tasks.delete(existingTask.id);
                        console.log(`🗑️ Removed stale completed absence task for ${displayName(student)}, creating fresh one`);
                        // Fall through to create new task below
                    } else {
                        // UPDATE the existing pending task: add today's date to the absence streak
                        let absenceDates = existingTask.absenceDates || [];
                        if (!absenceDates.includes(todayStr)) {
                            absenceDates.push(todayStr);
                            absenceDates.sort();

                            // Rebuild the description with all dates
                            const dateRange = this.formatAbsenceDates(absenceDates);
                            const periods = [...new Set(absentToday.filter(a => (parseInt(a.studentId) || a.studentId) === studentId).map(a => a.period))].join(', ');

                            // Append new missed work to existing
                            let allMissed = existingTask.missedWork || [];
                            if (missedItems.length > 0) {
                                allMissed.push(`${todayStr}: ${missedItems.join('; ')}`);
                            }

                            const missedSummary = allMissed.length > 0 ? ` | Missed: ${allMissed.join(' / ')}` : '';
                            const newDesc = `${displayName(student)} was absent ${dateRange} (${absenceDates.length} day${absenceDates.length > 1 ? 's' : ''})${missedSummary}`;

                            await db.tasks.update(existingTask.id, {
                                description: newDesc,
                                absenceDates: absenceDates,
                                missedWork: allMissed,
                                updatedAt: new Date().toISOString()
                            });
                            console.log(`📝 Absence follow-up updated: ${displayName(student)} (${absenceDates.length} days)`);
                        }
                        continue; // Already handled — skip the create block
                    }
                }

                // CREATE a new absence follow-up task
                const periods = [...new Set(absentToday.filter(a => (parseInt(a.studentId) || a.studentId) === studentId).map(a => a.period))].join(', ');
                const desc = `${displayName(student)} was absent ${todayStr}${missedStr}`;

                await db.tasks.add({
                    description: desc,
                    dueDate: null,
                    priority: 'high',
                    status: 'pending',
                    completed: false,
                    type: 'auto',
                    subtype: 'absence-followup',
                    autoKey: absenceKey,
                    linkedEntityType: 'student',
                    linkedEntityId: studentId,
                    absenceDates: [todayStr],
                    missedWork: missedItems.length > 0 ? [`${todayStr}: ${missedItems.join('; ')}`] : [],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
                driveSync.markDirty();
                console.log(`🆕 Absence follow-up created: ${displayName(student)}`);
            }
        } catch (err) {
            console.error('Absence follow-up generation failed:', err);
        }
    },

    formatAbsenceDates(dates) {
        if (dates.length === 1) return dates[0];
        if (dates.length === 2) return `${dates[0]} & ${dates[1]}`;
        // Check if consecutive
        const sorted = [...dates].sort();
        return `${sorted[0]} – ${sorted[sorted.length - 1]}`;
    },

    async checkLowInventory(tasksToAdd, shouldAdd) {
        const items = excludeDeleted(await db.inventory.toArray());
        const allCheckouts = await db.checkouts.toArray();

        for (const item of items) {
            if (!item.threshold || item.threshold <= 0) continue;

            const activeCheckouts = allCheckouts.filter(
                co => co.itemId === item.id && !co.returnedAt
            ).length;
            const available = (item.quantity || 0) - activeCheckouts;

            if (available <= item.threshold) {
                const key = `low-inv-${item.id}`;
                if (shouldAdd(key)) {
                    tasksToAdd.push({
                        description: `Reorder ${item.name} — only ${available} available (threshold: ${item.threshold})`,
                        dueDate: null,
                        priority: 'medium',
                        status: 'pending',
                        completed: false,
                        type: 'auto',
                        autoKey: key,
                        linkedEntityType: 'inventory',
                        linkedEntityId: item.id,
                        createdAt: new Date().toISOString()
                    });
                }
            }
        }
    },

    async checkOverdueCheckouts(tasksToAdd, shouldAdd, todayStr) {
        const allCheckouts = await db.checkouts.toArray();
        const allStudents = excludeDeleted(await db.students.toArray());
        const studentMap = new Map(allStudents.map(s => [s.id, s]));
        const allItems = excludeDeleted(await db.inventory.toArray());
        const itemMap = new Map(allItems.map(i => [i.id, i]));

        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        const threeDaysAgoStr = threeDaysAgo.toISOString();

        for (const co of allCheckouts) {
            if (co.returnedAt) continue;
            if (!co.checkedOutAt || co.checkedOutAt > threeDaysAgoStr) continue;

            const student = studentMap.get(co.studentId);
            const item = itemMap.get(co.itemId);
            if (!student || !item) continue;

            const daysOut = Math.floor((new Date() - new Date(co.checkedOutAt)) / (1000 * 60 * 60 * 24));
            const key = `overdue-co-${co.id}`;
            if (shouldAdd(key)) {
                tasksToAdd.push({
                    description: `${displayName(student)} has had ${item.name} checked out for ${daysOut} days`,
                    dueDate: todayStr,
                    priority: 'low',
                    status: 'pending',
                    completed: false,
                    type: 'auto',
                    autoKey: key,
                    linkedEntityType: 'inventory',
                    linkedEntityId: item.id,
                    createdAt: new Date().toISOString()
                });
            }
        }
    },

    async checkGradingNeeded(existingTasks) {
        try {
            const activities = excludeDeleted(await db.activities.toArray())
                .filter(a => a.status === 'active');
            const allSubmissions = await db.submissions.toArray();

            // Get class info for period display
            const periodMap = await db.settings.get('period-year-map');
            const classPeriodsMap = periodMap?.value || {};
            // Invert: classId -> period(s)
            const classToPeriodsMap = {};
            for (const [period, classId] of Object.entries(classPeriodsMap)) {
                const cid = parseInt(classId);
                if (!classToPeriodsMap[cid]) classToPeriodsMap[cid] = [];
                classToPeriodsMap[cid].push(period);
            }

            for (const activity of activities) {
                const submittedCount = allSubmissions.filter(
                    s => s.activityId === activity.id && s.status === 'submitted'
                ).length;

                const autoKey = `grading-needed-${activity.id}`;

                // Find existing task for this activity (pending or not)
                const existingTask = existingTasks.find(t => t.autoKey === autoKey);

                if (submittedCount > 0) {
                    // Build description
                    const periods = classToPeriodsMap[activity.classId] || [];
                    const periodStr = periods.length > 0
                        ? ` (${periods.map(p => 'P' + p).join(', ')})`
                        : '';
                    const desc = `Grade: ${activity.name} — ${submittedCount} submission${submittedCount !== 1 ? 's' : ''} ready${periodStr}`;

                    if (existingTask && !existingTask.completed) {
                        // UPDATE existing task with new count
                        if (existingTask.description !== desc) {
                            await db.tasks.update(existingTask.id, {
                                description: desc,
                                updatedAt: new Date().toISOString()
                            });
                            console.log(`📝 Grading task updated: ${activity.name} (${submittedCount} submitted)`);
                        }
                    } else if (!existingTask) {
                        // CREATE new task
                        await db.tasks.add({
                            description: desc,
                            dueDate: null,
                            priority: 'normal',
                            status: 'pending',
                            completed: false,
                            type: 'auto',
                            subtype: 'grading-needed',
                            autoKey: autoKey,
                            linkedEntityType: 'activity',
                            linkedEntityId: activity.id,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString()
                        });
                        console.log(`🆕 Grading task created: ${activity.name} (${submittedCount} submitted)`);
                    }
                    // If existingTask is completed but new submissions came in,
                    // delete the completed one so a fresh one can be created
                    else if (existingTask && existingTask.completed) {
                        await db.tasks.delete(existingTask.id);
                        await db.tasks.add({
                            description: desc,
                            dueDate: null,
                            priority: 'normal',
                            status: 'pending',
                            completed: false,
                            type: 'auto',
                            subtype: 'grading-needed',
                            autoKey: autoKey,
                            linkedEntityType: 'activity',
                            linkedEntityId: activity.id,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString()
                        });
                        console.log(`🔄 Grading task regenerated: ${activity.name} (${submittedCount} new submissions after previous grading)`);
                    }
                } else {
                    // No submitted work — remove the task if it exists and isn't completed
                    if (existingTask && !existingTask.completed) {
                        await db.tasks.delete(existingTask.id);
                        console.log(`✅ Grading task auto-resolved: ${activity.name} (all graded)`);
                    }
                }
            }
        } catch (err) {
            console.error('Grading-needed check failed:', err);
        }
    },

    async initializeSubmissions() {
        try {
            const today = new Date();
            const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

            const activities = excludeDeleted(await db.activities.toArray())
                .filter(a => a.status === 'active' && a.startDate && a.startDate <= todayStr);

            if (activities.length === 0) return;

            const allSubmissions = await db.submissions.toArray();
            const allAttendance = await db.attendance.toArray();
            const periodMap = await db.settings.get('period-year-map');
            const classPeriodsMap = periodMap?.value || {};
            const activeYear = await getActiveSchoolYear();
            const allEnrollments = await db.enrollments.toArray();
            const allStudents = excludeDeleted(await db.students.toArray())
                .filter(s => (s.status || 'active') === 'active');

            let created = 0;

            for (const activity of activities) {
                const periodsForClass = Object.entries(classPeriodsMap)
                    .filter(([period, classId]) => parseInt(classId) === activity.classId)
                    .map(([period]) => period);

                const enrolledStudentIds = new Set(
                    allEnrollments
                        .filter(e => periodsForClass.includes(String(e.period)) && (!e.schoolYear || e.schoolYear === activeYear))
                        .map(e => e.studentId)
                );

                const classStudents = allStudents.filter(s =>
                    s.classId === activity.classId || enrolledStudentIds.has(s.id)
                );

                for (const student of classStudents) {
                    const existing = allSubmissions.find(
                        s => s.activityId === activity.id && s.studentId === student.id
                    );
                    if (existing) continue;

                    const wasAbsentOnStart = periodsForClass.some(period =>
                        allAttendance.some(a =>
                            a.studentId === String(student.id) &&
                            a.date === activity.startDate &&
                            a.period === period &&
                            a.status === 'absent'
                        )
                    );

                    await db.submissions.add({
                        activityId: activity.id,
                        studentId: student.id,
                        status: wasAbsentOnStart ? 'not-started' : 'in-progress',
                        submittedAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    });
                    created++;
                }
            }

            if (created > 0) {
                console.log(`✅ Auto-submissions: initialized ${created} submission record(s)`);
            }
        } catch (err) {
            console.error('Auto-submission initialization failed:', err);
        }
    },
    
};
