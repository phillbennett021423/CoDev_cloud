// The plans and their limits. Adding a plan is a new entry here
// plus its Stripe price later; nothing else needs to change.
//
// chatTotal: messages for the whole life of the account (the trial), or null.
// chatPerDay: messages a day (UTC), or null for no limit.
// providers: which AI services the shared keys may be used for.
// videoMinutesPerMonth: video editing on the rented video machine (0 = not included).
export const PLANS = {
    trial: { label: 'Trial', chatTotal: 20, chatPerDay: null, providers: ['groq'], runCode: false, videoMinutesPerMonth: 0 },
    pro: { label: 'Pro plan', chatTotal: null, chatPerDay: 300, providers: ['groq', 'openrouter', 'anthropic'], runCode: true, videoMinutesPerMonth: 0 },
    // $40 a month, the first two months paid up front ($80), so the video machine is
    // paid for before anyone uses it. Not on sale until payments are built.
    // priority: keeps working when the daily total for everyone pauses shared AI.
    max: { label: 'Max plan', chatTotal: null, chatPerDay: 1000, providers: ['groq', 'openrouter', 'anthropic'], runCode: true, videoMinutesPerMonth: 120, priority: true },
    // Hidden: the owner approves testers on the Owner page. To the tester it is
    // the Pro plan in every way they can see.
    tester: { label: 'Pro plan', chatTotal: null, chatPerDay: 300, providers: ['groq', 'openrouter', 'anthropic'], runCode: true, videoMinutesPerMonth: 0, hidden: true },
    owner: { label: 'Owner', chatTotal: null, chatPerDay: null, providers: ['groq', 'openrouter', 'anthropic'], runCode: true, videoMinutesPerMonth: null }
};

// How many messages one request counts as. Anthropic costs far more per message.
export const COST_WEIGHTS = { groq: 1, openrouter: 1, anthropic: 10 };

// A rough cost of one request, in dollars, for the API agent's estimates. Not a bill:
// typical CoDev requests at each service's usual prices (OpenRouter's free router is $0).
export const EST_COST_PER_REQUEST = { groq: 0.002, openrouter: 0, anthropic: 0.01 };

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
    const { label, chatTotal, chatPerDay, providers, runCode, videoMinutesPerMonth } = plan;
    return { name: label, chatTotal, chatPerDay, providers: [...providers], runCode, videoMinutesPerMonth };
}
