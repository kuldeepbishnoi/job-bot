// Regenerate fixtures/amazon-apply.html from fixtures/amazon-forms.json.
//   node debug/amazon-fixture.mjs
// The question SCHEMA (ids, types, option keys/titles) is the real /api/apply/forms capture; the
// MARKUP around it mirrors what the apply app's React bundle renders (DropdownMenu, RadioField,
// CheckBox, MultiselectDropdownField, QuestionLabel, FormNavigation, the save-form footer),
// transcribed from static.account.amazon.jobs/assets/bundles/jobs/apply-*.js on 2026-09-02.
// It is NOT a saved live page (the apply page needs the user's session), so if Amazon ships new
// markup, re-derive it from the bundle and rerun this script rather than editing the HTML.
import { readFileSync, writeFileSync } from 'node:fs';

const { forms } = JSON.parse(readFileSync('fixtures/amazon-forms.json', 'utf8'));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
let guid = 0;
const id = (p) => `${p}-${(++guid).toString(36).padStart(4, '0')}`;

const label = (q) => `<div class="question question-text">
        <div class="question-label${q.required ? ' required' : ''}"><span class="question-prefix d-none" aria-hidden="true">Q. </span><label id="${q.id}-label" class="text-tooltip-label d-inline mb-0" aria-hidden="true">${esc(q.title)}</label><span class="sr-only">Question: ${esc(q.title)}${q.required ? ' required ' : ''}</span></div>
      </div>`;

const control = (q) => {
  switch (q.type) {
    case 'DROPDOWN':
      return `<div class="drop-down-menu mt-1"><div class="drop-down-menu-select"><label for="dropDownValues" style="width:100%"><select aria-label="Select an option"><option value=""></option>${q.options.map((o) => `<option value="${esc(o.key)}">${esc(o.title)}</option>`).join('')}</select></label></div></div>`;
    case 'MULTISELECT_DROPDOWN':
      return `<div class="multiselect-drop-down-menu mt-1"><label for="multiselectDropDownValues" style="width:100%"><select multiple="multiple">${q.options.map((o) => `<option value="${esc(o.key)}">${esc(o.title)}</option>`).join('')}</select></label></div>`;
    case 'RADIO_BUTTON':
      return `<div class="custom-controls-stacked">${q.options.map((o, i) => { const rid = id('radio'); return `<div class="custom-control custom-radio"><input name="${q.id}" data-testid="${q.id}-${esc(o.key)}" class="custom-control-input" type="radio" value="${esc(o.key)}" id="${rid}" role="radio"${q.required ? ' aria-required="true"' : ''}><label id="${q.id}-option-${i}-label" for="${rid}" class="custom-control-label">${esc(o.title)}</label></div>`; }).join('')}</div>`;
    case 'CHECK_LIST':
      return `<div class="check-box-list">${q.options.map((o, i) => `<div class="custom-control custom-checkbox"><input type="checkbox" class="custom-control-input" data-testid="${q.id}-${esc(o.key)}" value="${esc(o.key)}" id="${q.id}_checkbox-${esc(o.key)}"${q.required ? ' aria-required="true"' : ''}><label for="${q.id}_checkbox-${esc(o.key)}" id="${q.id}_checkbox-option-${i}-label" class="custom-control-label">${esc(o.title)}</label></div>`).join('')}</div>`;
    case 'BOOLEAN': {
      const cid = id('check');
      return `<div class="check-box"><div class="question question-text"></div><div class="custom-control custom-checkbox${q.required ? ' required' : ''}"><div class="text-tooltip-label"><input type="checkbox" class="custom-control-input" id="${cid}" aria-labelledby="${cid}-label"${q.required ? ' required' : ''}><label for="${cid}" id="${cid}-label" class="custom-control-label">${esc(q.title)}</label></div></div></div>`;
    }
    case 'TEXT':
      return `<div class="text-field mt-1"><input type="text" class="form-control" id="${q.id}"${q.required ? ' aria-required="true"' : ''}></div>`;
    case 'DATE':
      return `<div class="date-field mt-1"><input type="text" class="form-control datepicker" placeholder="MM/DD/YYYY"></div>`;
    default:
      return `<div class="unsupported">${q.type}</div>`;
  }
};

const question = (q) => `    <div class="form-group"><div class="question" data-questionId="${esc(q.id)}">
      ${q.type === 'BOOLEAN' ? '' : label(q)}
      ${control(q)}
    </div></div>`;

// Render: General questions (finished, display mode), Job-specific (ACTIVE, empty), the two
// self-ID forms (pending, hidden). Dependent questions (follow-ups) are not rendered, like the app.
const isDependent = (q) => (q.question_dependencies ?? []).length > 0;
const active = forms.find((f) => f.title === 'Job-specific questions');
const general = forms.find((f) => f.id.startsWith('GENERAL_QUESTIONS'));
const eeo = forms.find((f) => f.id.startsWith('VOLUNTARY_EQUAL'));
const military = forms.find((f) => f.id.startsWith('VOLUNTARY_SELF_IDENTIFICATION_OF_VETERAN'));

const nav = forms.map((f) => `      <li id="NAV_${esc(f.id)}" class="form-list-item arrow_box ${f === active ? 'active' : f.completed ? 'finished' : ''}" role="presentation"><a class="form-link nav-link" role="tab">${esc(f.title)}</a></li>`).join('\n');

const footer = `    <div class="card-footer py-0 save-form-container">
      <div class="d-lg-none"><a href="javascript:void(0)" class="btn btn-primary w-100">Continue</a></div>
      <div class="d-none d-lg-inline-block"><div class="form-group submit-button mt-5"><button type="button" class="btn btn-primary">Continue</button></div></div>
    </div>`;

const html = `<!-- GENERATED by debug/amazon-fixture.mjs from fixtures/amazon-forms.json — do not hand-edit. -->
<div class="application-questions"><div class="container application-questions-container"><div class="row application-questions-row">
  <div class="col-lg-4 form-navigation-container">
    <ul class="nav flex-column nav-pills form-list" role="tablist" aria-orientation="vertical">
${nav}
      <li class="form-list-item arrow_box"><span class="form-link nav-link" role="tab" aria-controls="REVIEW_AND_SUBMIT" aria-disabled="true">Review &amp; submit</span></li>
    </ul>
  </div>
  <div class="form-container col-lg-7"><div class="application-content"><div class="question-forms">

  <div class="card question-form form2 display">
    <div class="card-header"><h2>${esc(general.title)}</h2></div>
    <div class="card-body">
${general.questions.filter((q) => !isDependent(q)).map((q) => `    <div class="form-group"><div class="question" data-questionId="${esc(q.id)}">${label(q)}<div class="input-display-mode"><span class="answer-prefix" aria-hidden="true">A. </span><span>${q.type === 'DROPDOWN' ? 'Amazon Career Site' : 'N/A'}</span></div></div></div>`).join('\n')}
    </div>
  </div>

  <div class="card question-form form4 active">
    <div class="card-header"><h2>${esc(active.title)}</h2></div>
    <div class="card-body">
${active.questions.map(question).join('\n')}
    </div>
${footer}
  </div>

  <div class="card question-form form6" hidden>
    <div class="card-header"><h2>${esc(eeo.title)}</h2></div>
    <div class="card-body">
${eeo.questions.map(question).join('\n')}
    </div>
${footer}
  </div>

  <div class="card question-form form7" hidden>
    <div class="card-header"><h2>${esc(military.title)}</h2></div>
    <div class="card-body">
${military.questions.map(question).join('\n')}
    </div>
${footer}
  </div>

  </div></div></div>
</div></div></div>
`;
writeFileSync('fixtures/amazon-apply.html', html);
console.log('wrote fixtures/amazon-apply.html', html.length, 'chars');
