-- Question bank v2: the 10 "laughably easy" v1 questions are replaced with 10
-- new medium-difficulty originals; v1's 12 medium and 8 hard carry over.
-- v1 stays intact — competitions already running keep their bank.
insert into questions (bank_version, position, category, difficulty, prompt, options, correct_index, explanation) values
(2, 1,  'analogy',       'medium', 'Thermometer is to temperature as odometer is to ___.',
  '["Distance","Speed","Fuel","Pressure"]', 0,
  'An odometer measures distance the way a thermometer measures temperature.'),
(2, 2,  'word_relation', 'medium', 'Which word means most nearly the same as CONCISE?',
  '["Brief","Vague","Wordy","Loud"]', 0,
  'Concise means expressed in few words — brief.'),
(2, 3,  'number_series', 'medium', 'What number comes next: 4, 9, 19, 39, ___?',
  '["79","78","76","80"]', 0,
  'Each term doubles and adds one: 39 × 2 + 1 = 79.'),
(2, 4,  'arithmetic',    'medium', 'A 15% tip on a $60 dinner is how much?',
  '["$9.00","$6.00","$7.50","$12.00"]', 0,
  '10% of $60 is $6, plus half of that ($3) makes $9.'),
(2, 5,  'arithmetic',    'medium', 'Three friends split a $45 bill evenly, then each adds a $2 tip. How much does each pay?',
  '["$17","$15","$16","$19"]', 0,
  '$45 ÷ 3 = $15 each, plus $2 tip = $17.'),
(2, 6,  'logic',         'medium', 'Some Vims are Reds. All Reds are fast. What must be true?',
  '["Some Vims are fast","All Vims are fast","No Vims are slow","It cannot be determined"]', 0,
  'The Vims that are Reds must be fast, so at least some Vims are fast.'),
(2, 7,  'calendar',      'medium', 'The 3rd of a month falls on a Saturday. What day of the week is the 20th?',
  '["Tuesday","Wednesday","Monday","Thursday"]', 0,
  'The 20th is 17 days later; 17 = 2 weeks + 3 days, and Saturday + 3 is Tuesday.'),
(2, 8,  'pattern',       'medium', 'What letter comes next: Z, X, V, T, ___?',
  '["R","S","Q","P"]', 0,
  'The series steps backward through the alphabet two letters at a time.'),
(2, 9,  'word_relation', 'medium', 'Which word means the OPPOSITE of SCARCE?',
  '["Plentiful","Rare","Meager","Costly"]', 0,
  'Scarce means in short supply; plentiful is its opposite.'),
(2, 10, 'proverb',       'medium', '"Don''t count your chickens before they hatch" warns against ___.',
  '["assuming success before it happens","raising poultry","careless arithmetic","making plans too slowly"]', 0,
  'It cautions against banking on an outcome that hasn''t happened yet.');

insert into questions (bank_version, position, category, difficulty, prompt, options, correct_index, explanation)
select 2, position, category, difficulty, prompt, options, correct_index, explanation
from questions where bank_version = 1 and position > 10;
