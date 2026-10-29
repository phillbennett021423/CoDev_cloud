// The plans and their limits. Adding a plan (a Max plan, say) is a new entry here
// plus its Stripe price later; nothing else needs to change.
//
// chatTotal: messages for the whole life of the account (the trial), or null.
// chatPerDay: messages a day (UTC), or null for no limit.
// providers: which AI services the shared keys may be used for.
export const PLANS = {
    trial: { label: 'Trial', chatTotal: 20, chatPerDay: null, providers: ['groq'], runCode: false },
    pro: { label: 'Pro plan', chatTotal: null, chatPerDay: 300, providers: ['groq', 'openrouter', 'anthropic'], runCode: true },
    // Hidden: the owner approves testers on the Owner page. To the tester it is
    // the Pro plan in every way they can see.
    tester: { label: 'Pro plan', chatTotal: null, chatPerDay: 300, providers: ['groq', 'openrouter', 'anthropic'], runCode: true, hidden: true },
    owner: { label: 'Owner', chatTotal: null, chatPerDay: null, providers: ['groq', 'openrouter', 'anthropic'], runCode: true }
};

// How many messages one request counts as. Anthropic costs far more per message.
export const COST_WEIGHTS = { groq: 1, openrouter: 1, anthropic: 10 };

// Owner-editable on the Owner page.
// daily_cap: messages a day for everyone but the owner together; past it shared AI pauses until midnight.
// tester_cap: the most testers at once.
export const DEFAULT_SETTINGS = { daily_cap: 3000, tester_cap: 10 };

// The keys the owner can store on the server.
export const KEY_NAMES = ['groq', 'openrouter', 'anthropic'];

export function planFor(user, owner) {
    if (owner) return PLANS.owner;
    // An account stops being the owner's when OWNER_EMAIL changes.
    return (user.plan !== 'owner' && PLANS[user.plan]) || PLANS.trial;
}

// What an account is told about its own plan. A tester gets exactly what a Pro
// subscriber gets, so nothing reveals the tester plan.
export function publicPlan(plan) {
    const { label, chatTotal, chatPerDay, providers, runCode } = plan;
    return { name: label, chatTotal, chatPerDay, providers: [...providers], runCode };
}
