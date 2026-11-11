// The subjects a video can belong to. "studyHall" names the drop-in shown in the closing "More practice?" band.
export const SUBJECTS = {
  math: { name: "Mathematics", studyHall: "Math Study Hall" },
  cp:   { name: "Coding and Programming", studyHall: "C&P Study Hall" },
  chem: { name: "Chemistry", studyHall: "Chemistry Study Hall" },
  phys: { name: "Physics and Engineering", studyHall: "Physics and Engineering Study Hall" },
};
export const subjectOf = (stream) => SUBJECTS[stream] || SUBJECTS.math;
