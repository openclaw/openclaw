export function parseCourseName(course, fallbackString = '--') {
  return course ? `【${String(course.course_id).padStart(3, '0')}】${course.zh_name}` : fallbackString;
}

export function parseCourseVariantName(courseVariant) {
  return {
    group: '小班制',
    single: '一對一',
  }[courseVariant] ?? '--';
}
