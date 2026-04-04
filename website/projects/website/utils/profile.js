export function parseStudentIdString(profile) {
  return profile ? `TC-${String(profile.student_id).padStart(10, '0')}` : '--';
}

export function parseStudentName(profile) {
  return profile ? profile.full_name : '--';
}
