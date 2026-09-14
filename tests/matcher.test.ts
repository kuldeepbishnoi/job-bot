import { describe, it, expect } from 'vitest';
import { matchIntent, normalize } from '@/engine/matcher';

describe('matchIntent (real Datadog labels)', () => {
  const cases: [string, string | undefined][] = [
    ['Are you legally authorised to work full-time in the country where this job is based?', 'answers.work_authorization'],
    ['In what cities are you available to work?', 'locations'],
    ['Please select all the languages you speak fluently.', 'answers.languages'],
    ['How did you hear about this opportunity?', 'answers.how_did_you_hear'],
    ['I certify that the information provided in this application is true and correct', 'answers.acknowledge_true'],
    ["I understand my application will be processed in accordance with Datadog's Candidate Privacy Policy.", 'answers.privacy_consent'],
    ['Voluntary Self-Identification of Gender', 'answers.gender'],
    ['LinkedIn Profile', 'identity.linkedin'],
    ['Website', 'identity.website'],
    ['What is your expected salary?', 'answers.expected_salary'], // answered only if profile sets it, else park
  ];
  it.each(cases)('%s', (label, intent) => {
    expect(matchIntent(label)).toBe(intent);
  });
});

describe('matchIntent (LinkedIn Easy Apply labels)', () => {
  const cases: [string, string | undefined][] = [
    ['Phone country code', 'identity.phone_country'],
    ['Mobile phone number', 'identity.phone'],
    ['Email address', 'identity.email'],
    ['First name', 'identity.first_name'],
    ['Last name', 'identity.last_name'],
    ['City', 'identity.city'],
    ['What is your current location?', 'identity.city'],
    ['Are you comfortable commuting to this job\'s location?', 'answers.commute_ok'],
    ['Are you comfortable working in a hybrid setting?', 'answers.remote_ok'],
    ['How many years of work experience do you have with Java?', 'answers.years_of_experience'],
    ['Have you completed the following level of education: Bachelor\'s Degree?', 'answers.degree_bachelors'],
    ['What is your expected CTC (in LPA)?', 'answers.expected_salary'],
    ['What is your current CTC?', 'answers.current_salary'],
    ['What is your notice period (in days)?', 'answers.notice_period'],
    ['When can you start?', 'answers.start_date'],
    ['Are you willing to undergo a background check, in accordance with local law/regulations?', 'answers.background_check'],
    ['Are you 18 years or older?', 'answers.over_18'],
    ['What is your level of proficiency in English?', 'answers.language_proficiency'],
    ['Do you have a valid driver\'s license?', 'answers.drivers_license'],
    ['Will you now or in the future require sponsorship for employment visa status?', 'answers.needs_sponsorship'],
    ['Are you legally authorized to work in India?', 'answers.work_authorization'],
    ['Why do you want to work at Acme?', 'answers.cover_letter'],
    // Seen live 2026-09-06/14 (Swiggy / Freshworks SmartRecruiters-powered Easy Apply forms).
    ['How many years experience do you have?', 'answers.years_of_experience'],
    ['Please indicate how many exact years of relevant experience you have', 'answers.exact_years_of_experience'],
    ['Total experience (in years)', 'answers.years_of_experience'],
    ['What is your current fixed salary?', 'answers.current_fixed_salary'],
    ['What is your current variable salary?', 'answers.current_variable_salary'],
    ['Expected Salary', 'answers.expected_salary'],
    ['Total CTC - Fixed+Variable (INR_Annual)', 'answers.total_ctc'],
    ['What is your expected fixed salary?', 'answers.expected_salary'],
    ['What is your current notice period?', 'answers.notice_period'],
    ['Are you currently serving your notice period?', 'answers.notice_serving'],
    ['Are you an immediate joiner?', 'answers.immediate_joiner'],
    ['Are you willing to relocate to Bangalore?', 'answers.willing_to_relocate'],
    ['Are you currently located in Bangalore?', 'answers.in_city'],
    ['Gender', 'answers.gender'],
    ['Mark job as a top choice', 'answers.top_choice'],
    ['Include a message with your application', 'answers.cover_letter'],
    ['Are you comfortable working from office 5 days a week?', 'answers.commute_ok'],
    ['Are you comfortable with rotational shifts?', 'answers.shifts_ok'],
    ['Current company', 'answers.current_company'],
    ['Current designation', 'answers.current_title'],
    ['GitHub profile URL', 'answers.github'],
    ['Reason for job change', 'answers.reason_for_change'],
    ['Highest qualification', 'answers.education_level'],
    ['How many years of experience in Java?', 'answers.years_of_experience'],
    ['Do you have experience with Kafka?', 'answers.skills_experience'],
    ['How many experience in leading team?', 'answers.years_of_experience'], // live label, 2026-09-06 (sic)
    ['Do you have experience with Kubernetes?', 'answers.skills_experience'],
    ['In what cities are you available to work?', 'locations'],
    // Whole-word "city": Amazon's "…participate in any capacity…" and "ethnicity" are not cities.
    ['Did you participate in any capacity in those decisions?', undefined],
    ['Please provide additional information.', 'answers.cover_letter'], // a free-text box: the cover letter beats "N/A" // Amazon compliance follow-up — not a cover letter
  ];
  it.each(cases)('%s', (label, intent) => {
    expect(matchIntent(label)).toBe(intent);
  });
});

describe('matchIntent (real Amazon labels — fixtures/amazon-forms.json)', () => {
  const cases: [string, string | undefined][] = [
    ['Which option best describes your total non-internship professional software development experience?', 'answers.years_of_experience'],
    ['Which option best describes your total full software development life cycle, including coding standards, code reviews, source control management, build processes, testing, and operations experience?', 'answers.years_of_experience'],
    ['Do you have experience programming with at least one software programming language?', 'answers.skills_experience'],
    ['Do you have 5+ years of full software development life cycle, including coding standards, code reviews, source control management, build processes, testing, and operations experience?', 'answers.years_of_experience'],
    ['Do you have 3+ years of programming with at least one software programming language?', 'answers.years_of_experience'],
    ['Do you have experience with Machine Learning and Large Language Model fundamentals, including architecture, training/inference lifecycles, and optimization of model execution?', 'answers.skills_experience'],
    ["Do you have a Bachelor's degree in computer science or equivalent?", 'answers.degree_bachelors'],
    ["Do you have a Master's degree in computer science or equivalent?", 'answers.degree_masters'],
    ['Are you willing to relocate?', 'answers.willing_to_relocate'],
    ['How did you hear about this role?', 'answers.how_did_you_hear'],
    ['Do you need, or will you need in the future, any immigration-related support or sponsorship from Amazon in order to begin or continue employment with Amazon?', 'answers.needs_sponsorship'],
    ['Have you previously applied to Amazon or any Amazon subsidiary or affiliate?', 'answers.previously_applied'],
    ['Have you previously been employed by Amazon (including Amazon subsidiaries)?', 'answers.previous_employment'],
    ['Are you subject to a non-competition agreement or other agreement which would preclude or restrict your employment with Amazon?', 'answers.non_compete'],
    ['In the past 7 years, have you lived or were physically located outside of Canada for 12 consecutive months or more?', 'answers.lived_abroad'],
    ['Are you currently or, in the past three years, have you been a direct employee of any government entity?  This includes being a direct employee of any government entity at the federal/national, state/provincial, and local levels, a member of the armed forces, and/or a direct employee of any publicly funded institution.', 'answers.government_employee'],
    ['Which sanctioned country or region are you located in?', undefined], // the follow-up picker: not a yes/no
    ['Since obtaining your most recent citizenship, did you afterwards become a permanent resident in any other country/region?', 'answers.permanent_resident_elsewhere'],
    ['Please provide all the countries outside the Canada you have lived in consecutively for more than 12 months in the past 7 years.', 'answers.countries_lived'],
    ['Are you living in or are you currently physically located in any of the sanctioned countries or regions?', 'answers.sanctioned_country'],
    ['In which country/region do you have citizenship?', 'answers.citizenship'],
    ['By checking this box, I confirm I acknowledge the above.', 'answers.acknowledge_true'],
    ['Do you identify as an Indigenous Person?', 'answers.indigenous'],
    ['Do you identify as a person with a disability?', 'answers.disability'],
    ['Do you identify as Black/Person of Colour or Visible Minority?', 'answers.visible_minority'],
    ['Which one of the following best describes your racial or ethnic identity?', 'answers.racial_identity'],
    ['Do you identify your gender as:', 'answers.gender'],
    ['Are you ex-military (transitioning or former member of your country’s Armed Forces)?', 'answers.ex_military'],
    ['Are you a member of the Reserve Forces of your country?', 'answers.reserve_forces'],
    ['Are you a military spouse?', 'answers.military_spouse'],
    ['Preferred start date', 'answers.start_date'], // answered only if profile sets it, else park
    ['Education level', 'answers.education_level'],
    ['School name', 'answers.school_name'],
    ['Area(s) of study', 'answers.area_of_study'],
    ['Are you currently a student?', 'answers.currently_student'],
    ['When did you graduate?', 'answers.graduation'],
    ['Have you had relevant non-internship professional experience?', 'answers.relevant_experience'],
    ['If "Amazon Career Site" please specify', 'answers.how_did_you_hear_detail'],
  ];
  it.each(cases)('%s', (label, intent) => {
    expect(matchIntent(label)).toBe(intent);
  });

  it('normalizes punctuation and case', () => {
    expect(normalize('  How DID you   hear? ')).toBe('how did you hear');
  });
});

// Labels that a BROAD keyword used to swallow. The matcher is first-match-wins, so a bare term
// near the top of the list ("notice", "phone", "city") silently answers an unrelated question —
// each of these was produced by running the real matcher, not by reading it.
describe('matchIntent — broad terms must not shadow later rules', () => {
  const cases: [string, string | undefined][] = [
    ['Do you agree to our privacy notice?', 'answers.privacy_consent'],
    ['Will you be able to attend a phone screen?', undefined],
    ['Do you consent to a phone interview?', undefined],
    ['Which city or cities would you prefer to work in?', 'locations'],
    ['What city do you live in?', 'identity.city'],
    ['What is your notice period?', 'answers.notice_period'],
    ['Mobile phone number', 'identity.phone'],
    ['How much do you earn currently?', 'answers.current_salary'],
    ['Current Cost to Company', 'answers.current_salary'],
    ['What is your salary?', 'answers.current_salary'],
  ];
  it.each(cases)('%s', (label, intent) => expect(matchIntent(label)).toBe(intent));
});
