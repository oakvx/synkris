'use strict';
let onboardingGeneration = 0;
const ONBOARDING_IDS = ['database','activation','catalog','whatsapp','calendar','backup'];
const ONBOARDING_ACTIONS = {catalog:'Controlla team e trattamenti',chats:'Collega WhatsApp',overview:'Controlla il Centro operativo',settings:'Controlla i backup'};
async function loadOnboarding() {
  const generation = ++onboardingGeneration;
  const card = $('onboardingCard');
  card.setAttribute('aria-busy','true');
  try {
    const report = await synkBridge('/api/onboarding');
    if (generation !== onboardingGeneration) return;
    if (report.schema !== 1 || report.productionReady !== false || !Array.isArray(report.steps) || report.steps.length !== 6 ||
        ONBOARDING_IDS.some(id => report.steps.filter(step => step.id === id).length !== 1) ||
        report.steps.some(step => !['done','todo','attention','unknown'].includes(step.status) || typeof step.title !== 'string' || typeof step.help !== 'string')) throw new Error('invalid_checklist');
    const steps = ONBOARDING_IDS.map(id => report.steps.find(step => step.id === id));
    const completed = steps.filter(step => step.status === 'done').length;
    const next = steps.find(step => step.status !== 'done');
    $('onboardingSummary').textContent = completed + ' di 6 controlli automatici completati';
    $('onboardingProgress').value = completed;
    $('onboardingProgress').textContent = completed + '/6';
    $('onboardingMessage').textContent = next ? next.help : 'Controlli automatici completati. Prima dei clienti reali restano il collaudo WhatsApp, Calendar e il ripristino dei backup.';
    const actions = [];
    if (next?.page && Object.hasOwn(ONBOARDING_ACTIONS,next.page)) {
      const action = el('button',{type:'button',class:'primary',text:ONBOARDING_ACTIONS[next.page]});
      action.addEventListener('click',()=>void synkShowPage(next.page));actions.push(action);
    }
    $('onboardingActions').replaceChildren(...actions);
    const labels = {done:['VERIFICATO','good'],todo:['DA COMPLETARE','warning'],attention:['ATTENZIONE','bad'],unknown:['NON VERIFICATO','neutral']};
    $('onboardingList').replaceChildren(...steps.map((step,index)=>el('div',{class:'onboarding-step'},
      el('div',{class:'section-heading'},el('strong',{text:(index+1)+'. '+step.title}),badge(...labels[step.status])),el('p',{class:'muted',text:step.help}))));
    card.classList.remove('checklist-unavailable');
  } catch {
    if (generation !== onboardingGeneration) return;
    $('onboardingSummary').textContent = 'Stato dei controlli non disponibile';
    $('onboardingProgress').value = 0;$('onboardingProgress').textContent = '0/6';
    $('onboardingMessage').textContent = 'Non posso confermare lo stato attuale. Premi Ricontrolla o apri la diagnostica da INSTALLA_UNA_VOLTA. Nessun controllo precedente viene considerato ancora valido.';
    $('onboardingActions').replaceChildren();
    $('onboardingList').replaceChildren(empty('Nessun via libera: attendi una verifica riuscita.'));
    card.classList.add('checklist-unavailable');
  } finally {
    if (generation === onboardingGeneration) card.setAttribute('aria-busy','false');
  }
}
document.addEventListener('DOMContentLoaded',()=>{
  $('onboardingRefresh').addEventListener('click',event=>void runAction(loadOnboarding,event.currentTarget));
});
