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
    ['What is your expected salary?', undefined], // unknown -> park
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
    ['Preferred start date', undefined],
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
