/**
 * Get a chronologically sorted array of per-assignment RACE score averages for a student.
 * Each entry averages across all RACE-scored questions within that assignment.
 *
 * @param {number} studentId
 * @param {Object} [options]
 * @param {string|null} [options.schoolYear] - Filter by school year. Default: current year. null = all years.
 * @param {number} [options.minQuestions=1] - Minimum scored questions to include an assignment.
 * @returns {Promise<Object[]>} Array sorted by date, each: { activityId, activityName, date, questionCount, R, A, C, E, total, answeredMask }
 */
async function getRaceHistory(studentId, options = {}) {
    const { schoolYear, minQuestions = 1 } = options;

    const yearFilter = schoolYear === undefined
        ? await getActiveSchoolYear()
        : schoolYear; // null = all years

    const allSubmissions = await db.submissions.toArray();
    const allActivities = await db.activities.toArray();
    const activityMap = new Map(allActivities.map(a => [a.id, a]));

    const studentSubs = allSubmissions.filter(s =>
        s.studentId === studentId && s.raceScores && s.raceScores.length > 0
    );

    const results = [];

    for (const sub of studentSubs) {
        const activity = activityMap.get(sub.activityId);
        if (!activity) continue;

        // Year filter
        if (yearFilter !== null) {
            const actYear = activity.schoolYear || null;
            if (actYear && actYear !== yearFilter) continue;
            if (!actYear && activity.startDate) {
                const startMonth = parseInt(activity.startDate.split('-')[1]);
                const startCalYear = parseInt(activity.startDate.split('-')[0]);
                const yearStart = parseInt(yearFilter.split('-')[0]);
                const inYear = (startCalYear === yearStart && startMonth >= 8) ||
                                (startCalYear === yearStart + 1 && startMonth <= 7);
                if (!inYear) continue;
            }
        }

        // Average across questions
        let rSum = 0, aSum = 0, cSum = 0, eSum = 0;
        let rCount = 0, aCount = 0, cCount = 0, eCount = 0;

        for (const rs of sub.raceScores) {
            if (rs.R != null) { rSum += rs.R; rCount++; }
            if (rs.A != null) { aSum += rs.A; aCount++; }
            if (rs.C != null) { cSum += rs.C; cCount++; }
            if (rs.E != null) { eSum += rs.E; eCount++; }
        }

        const totalQuestions = sub.raceScores.length;
        if (totalQuestions < minQuestions) continue;

        const R = rCount > 0 ? Math.round((rSum / rCount) * 10) / 10 : null;
        const A = aCount > 0 ? Math.round((aSum / aCount) * 10) / 10 : null;
        const C = cCount > 0 ? Math.round((cSum / cCount) * 10) / 10 : null;
        const E = eCount > 0 ? Math.round((eSum / eCount) * 10) / 10 : null;

        // Total is only meaningful if all 4 letters were scored
        const total = (R != null && A != null && C != null && E != null)
            ? Math.round((R + A + C + E) * 10) / 10
            : null;

        // Date for sorting: prefer submittedAt, then activity endDate, then updatedAt
        const date = sub.submittedAt || activity.endDate || sub.updatedAt || '';

        results.push({
            activityId: activity.id,
            activityName: activity.name || 'Untitled',
            date,
            questionCount: totalQuestions,
            R, A, C, E, total,
            answeredMask: { R: rCount, A: aCount, C: cCount, E: eCount }
        });
    }

    // Sort by date ascending
    results.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    return results;
}