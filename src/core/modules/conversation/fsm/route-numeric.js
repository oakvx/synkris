/** Declarative routing of migrated numerical conversation substates. */
export function createNumericRouter({ review, professional, confirmService, selectService }) {
 const steps=new Map([
   ['review_intake',review],
   ['pick_professional_for_time',professional],
   ['confirm_service',confirmService],
   ['choose_service',selectService],
 ]);
 return async (context) => {
   const handler=steps.get(context.state?.step);
   if(!handler || (context.state.step==='choose_service'&&!context.pureNumber.test(context.msg)))
     return {handled:false};
   return {handled:true,result:await handler(context)};
 };
}
