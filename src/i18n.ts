// Every word the interface shows, in each language it speaks. English is the
// reference: the other languages are typed against it, so a missing or
// misspelled message is a build error rather than English text left behind.
//
// Static text in index.html carries data-i18n attributes and is filled in
// from here by applyStaticText(); text the code builds reads `T` directly,
// which always holds the current language.

export type Lang = 'en' | 'pt';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const en = {
  // ------------------------------------------------------------ static page
  sessions: 'Sessions',
  sessionsTitle: 'Every session you have recorded, plus import and export',
  settings: 'Settings',
  settingsTitle: 'Theme, language, step pace, sample period and display',
  trackingPlot: 'Tracking plot',
  target: 'Target',
  you: 'You',
  model: 'Model',
  ready: 'Ready',
  recordSession: 'Record session',
  recordTitle: 'Record a new session — track the target with your pointer (the Space bar starts and stops it too)',
  replay: 'Replay',
  session: 'Session',
  nameSession: 'Name this session',
  untickHint: 'Untick a step response to leave it out of the model',
  noStepsYet: 'Step responses appear here as you record, one per step.',
  stepDetails: 'Step details',
  stepNDetails: (n: number) => `Step ${n} details`,
  modelDetails: 'Model details',
  plotKey: 'Key for the plots below',
  measured: 'Measured',
  stepsScaled: 'Steps, scaled',
  draggedModel: 'Dragged model',
  fit: 'Fit',
  firstOrderFit: '1st-order fit',
  stepResponse: 'Step response',
  frequencyResponse: 'Frequency response',
  poles: 'Poles (z‑plane)',
  dragToExplore: ' · drag to explore',
  polePlotLabel: "Second-order pole pair. Drag it, or use the arrow keys, to see how the model's response changes. Escape returns it to the fit.",
  backToFit: 'Back to the fit',
  fitMethod: 'How the model is fitted',
  medianFit: 'Median fit',
  medianFitTitle: "The median of each step response's own fit",
  jointFit: 'Joint fit',
  jointFitTitle: 'One model fitted to all the ticked step responses at once',
  noModelYet: 'Record a few step responses and the identified model appears here, updating as each step interval completes.',
  recordedSessions: 'Recorded sessions',
  sessionsEmpty: 'Recorded sessions are saved here.',
  sessionsUnavailable: 'This browser is not letting the app keep sessions, so export any session you want to keep.',
  importTxt: 'Import .txt…',
  importTitle: 'Add a session from a .txt file and open it',
  done: 'Done',
  samples: 'Samples',
  samplesLabel: 'Samples: n, target x[n], you y[n]',
  exportTxt: 'Export .txt…',
  exportTitle: 'Save these samples as a .txt file',
  theme: 'Theme',
  light: 'Light',
  dark: 'Dark',
  system: 'System',
  language: 'Language',
  stepTime: 'Average time between steps:',
  seconds: (n: number) => `${n} ${plural(n, 'second', 'seconds')}`,
  samplePeriod: 'Sample period (ms)',
  drawDots: 'Draw samples as dots, not lines',
  selfTest: 'Diagnostic self-test',
  whoTracks: 'Who tracks the target',
  firstOrderModelCap: 'First-order model',
  secondOrderModelCap: 'Second-order model',
  selfTestNote:
    "Lets the identified model do the tracking instead of you. Identifying a model's own run should give back that model's numbers, which checks the whole pipeline end to end. Runs made this way are labelled as model runs, never as yours.",
  resetDefaults: 'Reset to defaults',
  resetTitle: 'Restore every setting here to its default',

  // ------------------------------------------------------------- run status
  recording: 'Recording',
  modelRun: (order: 'first' | 'second') => `Model run (${order === 'first' ? 'first' : 'second'}-order)`,
  noStepsYetStatus: 'no steps yet',
  stepOf: (n: number, max: number) => `step ${n} of ${max}`,
  replaying: 'Replaying',
  replayFinished: 'Replay finished',
  stopped: 'Stopped',
  modelRunStopped: 'Model run stopped',
  samplesCount: (n: number) => `${n} samples`,
  nothingRecordedStatus: 'Stopped · nothing recorded',
  noCompleteStatus: 'Stopped · no complete step responses',
  sessionRecorded: 'Session recorded',
  modelRunFinished: 'Model run finished',
  nothingRecorded: 'Nothing recorded',
  noComplete: 'No complete step responses',
  noCompleteKept: 'No complete step responses · previous session kept',
  stepResponses: (n: number) => `${n} step ${plural(n, 'response', 'responses')}`,
  availableAfterRun: 'Available when this run stops',
  nothingToReplay: 'Nothing to replay yet — record a session first, or open one from Sessions',
  replayTitle: "Replay this session with the model's response to the same steps overlaid",
  stopBeforeImport: 'Stop the run before importing a session',
  loaded: (n: number, file: string) => `Loaded ${n} samples from ${file}`,
  alreadyKept: 'already in your sessions',
  notADataFile: (file: string) => `${file} has no samples this app can read`,
  reopened: (name: string) => `Reopened ${name}`,
  opened: (when: string) => `Opened the session from ${when}`,
  modelTracking: 'Model (tracking)',

  // ------------------------------------------------------------- plot help
  modelIsTracking: (model: string) => `The ${model} is tracking the target, not you`,
  tapToStopRun: 'Tap the plot to stop the run',
  clickToStop: 'Click the plot or press the Space bar to stop',
  slideFinger: "Slide your finger up and down to match the target's height",
  movePointer: "Move your pointer up and down to match the target's height",
  liftToStop: 'Lift your finger to stop recording',
  tapToStopReplay: 'Tap the plot to stop the replay',
  whenRecording: (touch: boolean) => `When recording, follow the target's height with your ${touch ? 'finger' : 'pointer'}`,
  holdToRecord: 'Hold the record button or the plot to record; lift to stop',
  spaceBar: 'Space bar also starts and stops recording',
  replayHelp: 'Replay this session with the model overlaid',

  // ---------------------------------------------------------------- strip
  countNote: (n: number, touch: boolean) =>
    n === 1 ? '1 step response' : `${n} step responses, ${touch ? 'tap' : 'select'} one to see details`,
  stepN: (n: number) => `Step ${n}`,
  err: 'err',
  rmsTitle: (rms: string, step: string) => `RMS ${rms} px on a ${step} px step`,
  fitsWorse: ' — fits far worse than the other step responses',
  fitsBetter: ' — fits far better than is plausible; little to measure here',
  includeStep: (n: number) => `Include step ${n} in the model`,
  steps: (n: number) => `${n} ${plural(n, 'step', 'steps')}`,
  tickToBuild: 'Tick at least one step response to build the model',
  jointOf: (n: number) => `One model fitted to the ${n} ticked step ${plural(n, 'response', 'responses')}`,
  medianOf: (n: number) => `The median of the fits of the ${n} ticked step ${plural(n, 'response', 'responses')}`,

  // ----------------------------------------------------------- readout
  stepModel: (n: number) => `Step ${n} model`,
  selfTestSuffix: ' · self-test',
  medianModel: 'Median model',
  jointModel: 'Joint model',
  allExcluded: 'All step responses excluded',
  tickToIdentify: 'Tick at least one step response to identify a model.',
  fittedToN: (n: number) => `Fitted to ${n} step ${plural(n, 'response', 'responses')}`,
  medianOfN: (n: number) => `Median of ${n} step ${plural(n, 'response', 'responses')}`,
  excludedN: (n: number) => ` · ${n} excluded`,
  poleAdjusted: ' · pole adjusted',
  settlesIn: (s: string) => `settles in ~${s} s`,
  settlesTooSlowly: 'settles too slowly to quote',
  reactionDelay: 'Reaction delay',
  beforeResponse: 'before the response begins',
  overshoot: 'Overshoot',
  pastTarget: 'past the target on the first swing',
  damping: 'Damping ζ',
  naturalFrequency: 'Natural frequency',
  verdict: (o: { inStep: boolean; byModel: boolean; delay: string; overshoot: string | null }) =>
    `${o.inStep ? 'In this step, ' : ''}${
      o.byModel ? (o.inStep ? 'the model reacts' : 'The model reacts') : o.inStep ? 'you react' : 'You react'
    } after <strong>${o.delay} ms</strong>, then ${o.byModel ? 'closes' : 'close'} in on the target` +
    (o.overshoot ? `, overshooting by <strong>${o.overshoot}%</strong> before settling.` : ' without overshooting.'),
  continuous: 'Continuous · derived from the fit',
  discrete: (ms: number) => `Discrete · sampled every ${ms} ms`,
  firstOrderLine: (tau: string, delay: string) => `Best first-order fit: τ = ${tau} s, delay ${delay} ms`,
  stepFlag: (kind: 'poor' | 'degenerate', excluded: boolean) =>
    `Relative to its step size, this step fits more than 3× ${
      kind === 'poor'
        ? 'worse than the median, so it may not have measured the same system'
        : 'better than the median, likely too little movement to measure'
    }${excluded ? '.' : '; untick it to leave it out of the model.'}`,
  fitsWorseN: (n: number) => `${n} step ${plural(n, 'response fits', 'responses fit')} more than 3× worse than the median`,
  fitsBetterN: (n: number) =>
    `${n} step ${plural(n, 'response fits', 'responses fit')} more than 3× better than the median, likely too little movement to measure`,
  modelFlag: (notes: string[], flagged: number) =>
    `Relative to step size, ${notes.join('; ')}. ${flagged === 1 ? "It's" : "They're"} marked ⚠ in Session; untick ${
      flagged === 1 ? 'it' : 'one'
    } to see how much it moves the model.`,
  damped: { underdamped: 'underdamped', 'critically damped': 'critically damped', overdamped: 'overdamped' },
  poleReadout: (zeta: string, character: string, wn: string, overshoot: string) =>
    `ζ ${zeta} ${character} · ωn ${wn} rad/s · ${overshoot}% overshoot`,
  errOnAverage: ' on average',

  // ---------------------------------------------------------- models, runs
  firstOrderModel: 'first-order model',
  secondOrderModel: 'second-order model',
  identifiedModel: 'the identified model',
  demoModel: 'built-in demo model; record a run to replace it',
  modelInUse: (source: string, wn: string, zeta: string, character: string, overshoot: string) =>
    `Model in use: ${source} — ωn ${wn} rad/s, ζ ${zeta} (${character}, ${overshoot}% overshoot)`,

  // ------------------------------------------------------------- sessions
  today: (time: string) => `Today · ${time}`,
  yesterday: (time: string) => `Yesterday · ${time}`,
  allExcludedShort: 'all excluded',
  msDelay: (ms: string) => `${ms} ms delay`,
  clickToRename: (name: string) => `${name} — click to rename`,
  onScreenNotKept: 'On screen · not kept',
  data: 'Data',
  samplesOnScreen: 'Samples of the session on screen',
  theSessionOnScreen: 'the session on screen',
  samplesOf: (when: string) => `Samples of the session from ${when}`,
  openSession: 'Open this session',
  notePlaceholder: 'Add a note: mouse, trackpad, tired…',
  noteFor: (when: string) => `Note for the session from ${when}`,
  delete: 'Delete',
  deleteConfirm: 'Delete?',
  deleteSession: (when: string) => `Delete the session from ${when}`,
  samplesMeta: (n: number, ms: number, s: string) => `${n} samples · one every ${ms} ms · ${s} s`,

  // ---------------------------------------------------------------- plots
  unitCircle: 'unit circle',
  radPerSample: 'ω (rad/sample)',
};

export type Messages = {
  [K in keyof typeof en]: (typeof en)[K] extends (...args: infer A) => string
    ? (...args: A) => string
    : (typeof en)[K] extends string
      ? string
      : { [D in keyof (typeof en)[K]]: string };
};

const pt: Messages = {
  sessions: 'Sessões',
  sessionsTitle: 'Todas as sessões que você gravou, além de importar e exportar',
  settings: 'Configurações',
  settingsTitle: 'Tema, idioma, ritmo dos degraus, período de amostragem e exibição',
  trackingPlot: 'Gráfico de rastreamento',
  target: 'Alvo',
  you: 'Você',
  model: 'Modelo',
  ready: 'Pronto',
  recordSession: 'Gravar sessão',
  recordTitle: 'Gravar uma nova sessão — acompanhe o alvo com o ponteiro (a barra de espaço também inicia e para)',
  replay: 'Reproduzir',
  session: 'Sessão',
  nameSession: 'Dê um nome a esta sessão',
  untickHint: 'Desmarque uma resposta ao degrau para deixá-la fora do modelo',
  noStepsYet: 'As respostas ao degrau aparecem aqui enquanto você grava, uma por degrau.',
  stepDetails: 'Detalhes do degrau',
  stepNDetails: (n) => `Detalhes do degrau ${n}`,
  modelDetails: 'Detalhes do modelo',
  plotKey: 'Legenda dos gráficos abaixo',
  measured: 'Medido',
  stepsScaled: 'Degraus, normalizados',
  draggedModel: 'Modelo arrastado',
  fit: 'Ajuste',
  firstOrderFit: 'Ajuste de 1ª ordem',
  stepResponse: 'Resposta ao degrau',
  frequencyResponse: 'Resposta em frequência',
  poles: 'Polos (plano z)',
  dragToExplore: ' · arraste para explorar',
  polePlotLabel:
    'Par de polos de segunda ordem. Arraste-o, ou use as setas do teclado, para ver como a resposta do modelo muda. Esc volta ao ajuste.',
  backToFit: 'Voltar ao ajuste',
  fitMethod: 'Como o modelo é ajustado',
  medianFit: 'Ajuste mediano',
  medianFitTitle: 'A mediana do ajuste de cada resposta ao degrau',
  jointFit: 'Ajuste conjunto',
  jointFitTitle: 'Um único modelo ajustado a todas as respostas ao degrau marcadas de uma vez',
  noModelYet:
    'Grave algumas respostas ao degrau e o modelo identificado aparece aqui, atualizado ao fim de cada intervalo entre degraus.',
  recordedSessions: 'Sessões gravadas',
  sessionsEmpty: 'As sessões gravadas ficam salvas aqui.',
  sessionsUnavailable: 'Este navegador não deixa o app guardar sessões; exporte as que quiser manter.',
  importTxt: 'Importar .txt…',
  importTitle: 'Adicionar uma sessão a partir de um arquivo .txt e abri-la',
  done: 'Concluir',
  samples: 'Amostras',
  samplesLabel: 'Amostras: n, alvo x[n], você y[n]',
  exportTxt: 'Exportar .txt…',
  exportTitle: 'Salvar estas amostras como um arquivo .txt',
  theme: 'Tema',
  light: 'Claro',
  dark: 'Escuro',
  system: 'Sistema',
  language: 'Idioma',
  stepTime: 'Tempo médio entre degraus:',
  seconds: (n) => `${n} ${plural(n, 'segundo', 'segundos')}`,
  samplePeriod: 'Período de amostragem (ms)',
  drawDots: 'Desenhar as amostras como pontos, não linhas',
  selfTest: 'Autoteste de diagnóstico',
  whoTracks: 'Quem acompanha o alvo',
  firstOrderModelCap: 'Modelo de primeira ordem',
  secondOrderModelCap: 'Modelo de segunda ordem',
  selfTestNote:
    'Deixa o modelo identificado fazer o rastreamento no seu lugar. Identificar a gravação do próprio modelo deve devolver os números desse modelo, o que verifica todo o processo de ponta a ponta. Gravações feitas assim são marcadas como do modelo, nunca como suas.',
  resetDefaults: 'Restaurar padrões',
  resetTitle: 'Voltar todas estas configurações ao padrão',

  recording: 'Gravando',
  modelRun: (order) => `Gravação do modelo (${order === 'first' ? 'primeira' : 'segunda'} ordem)`,
  noStepsYetStatus: 'nenhum degrau ainda',
  stepOf: (n, max) => `degrau ${n} de ${max}`,
  replaying: 'Reproduzindo',
  replayFinished: 'Reprodução concluída',
  stopped: 'Parado',
  modelRunStopped: 'Gravação do modelo parada',
  samplesCount: (n) => `${n} amostras`,
  nothingRecordedStatus: 'Parado · nada gravado',
  noCompleteStatus: 'Parado · nenhuma resposta ao degrau completa',
  sessionRecorded: 'Sessão gravada',
  modelRunFinished: 'Gravação do modelo concluída',
  nothingRecorded: 'Nada gravado',
  noComplete: 'Nenhuma resposta ao degrau completa',
  noCompleteKept: 'Nenhuma resposta ao degrau completa · sessão anterior mantida',
  stepResponses: (n) => `${n} ${plural(n, 'resposta', 'respostas')} ao degrau`,
  availableAfterRun: 'Disponível quando esta gravação parar',
  nothingToReplay: 'Nada para reproduzir ainda — grave uma sessão primeiro, ou abra uma em Sessões',
  replayTitle: 'Reproduzir esta sessão com a resposta do modelo aos mesmos degraus sobreposta',
  stopBeforeImport: 'Pare a gravação antes de importar uma sessão',
  loaded: (n, file) => `${n} amostras carregadas de ${file}`,
  alreadyKept: 'já está nas suas sessões',
  notADataFile: (file) => `${file} não tem amostras que este app consiga ler`,
  reopened: (name) => `${name} reaberta`,
  opened: (when) => `Sessão de ${when} aberta`,
  modelTracking: 'Modelo (rastreando)',

  modelIsTracking: (model) => `O ${model} está acompanhando o alvo, não você`,
  tapToStopRun: 'Toque no gráfico para parar a gravação',
  clickToStop: 'Clique no gráfico ou aperte a barra de espaço para parar',
  slideFinger: 'Deslize o dedo para cima e para baixo para acompanhar a altura do alvo',
  movePointer: 'Mova o ponteiro para cima e para baixo para acompanhar a altura do alvo',
  liftToStop: 'Levante o dedo para parar de gravar',
  tapToStopReplay: 'Toque no gráfico para parar a reprodução',
  whenRecording: (touch) => `Ao gravar, acompanhe a altura do alvo com ${touch ? 'o dedo' : 'o ponteiro'}`,
  holdToRecord: 'Segure o botão de gravar ou o gráfico para gravar; solte para parar',
  spaceBar: 'A barra de espaço também inicia e para a gravação',
  replayHelp: 'Reproduza esta sessão com o modelo sobreposto',

  countNote: (n, touch) =>
    n === 1 ? '1 resposta ao degrau' : `${n} respostas ao degrau, ${touch ? 'toque em' : 'selecione'} uma para ver detalhes`,
  stepN: (n) => `Degrau ${n}`,
  err: 'erro',
  rmsTitle: (rms, step) => `RMS de ${rms} px num degrau de ${step} px`,
  fitsWorse: ' — ajuste muito pior que o das outras respostas ao degrau',
  fitsBetter: ' — ajuste melhor do que é plausível; pouco a medir aqui',
  includeStep: (n) => `Incluir o degrau ${n} no modelo`,
  steps: (n) => `${n} ${plural(n, 'degrau', 'degraus')}`,
  tickToBuild: 'Marque pelo menos uma resposta ao degrau para construir o modelo',
  jointOf: (n) => `Um único modelo ajustado ${plural(n, 'à resposta', `às ${n} respostas`)} ao degrau ${plural(n, 'marcada', 'marcadas')}`,
  medianOf: (n) => `A mediana dos ajustes ${plural(n, 'da resposta', `das ${n} respostas`)} ao degrau ${plural(n, 'marcada', 'marcadas')}`,

  stepModel: (n) => `Modelo do degrau ${n}`,
  selfTestSuffix: ' · autoteste',
  medianModel: 'Modelo mediano',
  jointModel: 'Modelo conjunto',
  allExcluded: 'Todas as respostas ao degrau excluídas',
  tickToIdentify: 'Marque pelo menos uma resposta ao degrau para identificar um modelo.',
  fittedToN: (n) => `Ajustado a ${n} ${plural(n, 'resposta', 'respostas')} ao degrau`,
  medianOfN: (n) => `Mediana de ${n} ${plural(n, 'resposta', 'respostas')} ao degrau`,
  excludedN: (n) => ` · ${n} ${plural(n, 'excluída', 'excluídas')}`,
  poleAdjusted: ' · polo ajustado',
  settlesIn: (s) => `acomoda em ~${s} s`,
  settlesTooSlowly: 'acomoda devagar demais para estimar',
  reactionDelay: 'Atraso de reação',
  beforeResponse: 'antes de a resposta começar',
  overshoot: 'Sobressinal',
  pastTarget: 'além do alvo na primeira oscilação',
  damping: 'Amortecimento ζ',
  naturalFrequency: 'Frequência natural',
  verdict: (o) =>
    `${o.inStep ? 'Neste degrau, ' : ''}${
      o.byModel ? (o.inStep ? 'o modelo reage' : 'O modelo reage') : o.inStep ? 'você reage' : 'Você reage'
    } após <strong>${o.delay} ms</strong> e se aproxima do alvo` +
    (o.overshoot ? `, passando dele em <strong>${o.overshoot}%</strong> antes de se acomodar.` : ' sem ultrapassá-lo.'),
  continuous: 'Contínuo · derivado do ajuste',
  discrete: (ms) => `Discreto · amostrado a cada ${ms} ms`,
  firstOrderLine: (tau, delay) => `Melhor ajuste de primeira ordem: τ = ${tau} s, atraso de ${delay} ms`,
  stepFlag: (kind, excluded) =>
    `Em relação ao tamanho do degrau, o ajuste deste degrau é mais de 3× ${
      kind === 'poor'
        ? 'pior que a mediana, então talvez não tenha medido o mesmo sistema'
        : 'melhor que a mediana, provavelmente com movimento pequeno demais para medir'
    }${excluded ? '.' : '; desmarque-o para deixá-lo fora do modelo.'}`,
  fitsWorseN: (n) =>
    `${plural(n, 'o ajuste de 1 resposta ao degrau é', `os ajustes de ${n} respostas ao degrau são`)} mais de 3× ${
      n === 1 ? 'pior' : 'piores'
    } que a mediana`,
  fitsBetterN: (n) =>
    `${plural(n, 'o ajuste de 1 resposta ao degrau é', `os ajustes de ${n} respostas ao degrau são`)} mais de 3× ${
      n === 1 ? 'melhor' : 'melhores'
    } que a mediana, provavelmente com movimento pequeno demais para medir`,
  modelFlag: (notes, flagged) =>
    `Em relação ao tamanho do degrau, ${notes.join('; ')}. ${
      flagged === 1 ? 'Está marcada' : 'Estão marcadas'
    } com ⚠ em Sessão; desmarque ${flagged === 1 ? 'a resposta' : 'uma delas'} para ver quanto isso muda o modelo.`,
  damped: { underdamped: 'subamortecido', 'critically damped': 'criticamente amortecido', overdamped: 'superamortecido' },
  poleReadout: (zeta, character, wn, overshoot) => `ζ ${zeta} ${character} · ωn ${wn} rad/s · ${overshoot}% de sobressinal`,
  errOnAverage: ' em média',

  firstOrderModel: 'modelo de primeira ordem',
  secondOrderModel: 'modelo de segunda ordem',
  identifiedModel: 'o modelo identificado',
  demoModel: 'modelo de demonstração; grave uma sessão para substituí-lo',
  modelInUse: (source, wn, zeta, character, overshoot) =>
    `Modelo em uso: ${source} — ωn ${wn} rad/s, ζ ${zeta} (${character}, ${overshoot}% de sobressinal)`,

  today: (time) => `Hoje · ${time}`,
  yesterday: (time) => `Ontem · ${time}`,
  allExcludedShort: 'todas excluídas',
  msDelay: (ms) => `atraso de ${ms} ms`,
  clickToRename: (name) => `${name} — clique para renomear`,
  onScreenNotKept: 'Na tela · não guardada',
  data: 'Dados',
  samplesOnScreen: 'Amostras da sessão na tela',
  theSessionOnScreen: 'a sessão na tela',
  samplesOf: (when) => `Amostras da sessão de ${when}`,
  openSession: 'Abrir esta sessão',
  notePlaceholder: 'Adicione uma nota: mouse, trackpad, cansado…',
  noteFor: (when) => `Nota da sessão de ${when}`,
  delete: 'Excluir',
  deleteConfirm: 'Excluir?',
  deleteSession: (when) => `Excluir a sessão de ${when}`,
  samplesMeta: (n, ms, s) => `${n} amostras · uma a cada ${ms} ms · ${s} s`,

  unitCircle: 'círculo unitário',
  radPerSample: 'ω (rad/amostra)',
};

const dictionaries: Record<Lang, Messages> = { en, pt };

/** The current language's messages. A live binding: always the current language. */
export let T: Messages = en;
export let lang: Lang = 'en';

/** The BCP 47 tag dates and times are formatted in. */
export const locale = () => (lang === 'pt' ? 'pt-BR' : 'en-US');

/** The language to start in when none is stored: the browser's, if it is one of these. */
export function browserLang(): Lang {
  return navigator.language.toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

export function setLang(next: Lang) {
  lang = next;
  T = dictionaries[next];
  document.documentElement.lang = next === 'pt' ? 'pt-BR' : 'en';
  applyStaticText();
}

/**
 * Fills in the page's static text: data-i18n sets an element's text, and
 * data-i18n-title, -aria-label and -placeholder set those attributes, each
 * naming a message.
 */
export function applyStaticText(root: ParentNode = document) {
  const message = (key: string | undefined) => {
    const m = key ? (T as Record<string, unknown>)[key] : undefined;
    return typeof m === 'string' ? m : undefined;
  };
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const text = message(el.dataset.i18n);
    if (text !== undefined) el.textContent = text;
  }
  for (const [attr, dataKey] of [
    ['title', 'i18nTitle'],
    ['aria-label', 'i18nAriaLabel'],
    ['placeholder', 'i18nPlaceholder'],
  ] as const) {
    for (const el of root.querySelectorAll<HTMLElement>(`[data-${dataKey.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}]`)) {
      const text = message(el.dataset[dataKey]);
      if (text !== undefined) el.setAttribute(attr, text);
    }
  }
}
