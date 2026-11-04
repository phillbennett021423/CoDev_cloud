// Expert coach: makes CoDev's agents work like a seasoned pro in the user's field, at the
// user's level, either teaching the user to do the work or doing it for them.
//
//   CodevExpertise.PROFESSIONS                the built-in playbooks: the field's real work,
//                                             its quality bar, beginner mistakes, terms,
//                                             the CoDev tools that fit and a learning path
//   CodevExpertise.findProfession(text)       the playbook a profession name points to
//   CodevExpertise.detectProfessions(text)    playbooks a request is about (at most 2)
//   CodevExpertise.modeFromMessage(text)      "teach" | "do" | null, from "show me how",
//                                             "walk me through", "just do it"...
//   CodevExpertise.createExpertise(deps)      { profile(), save(patch), promptBlock(task),
//                                               toolNote(tools, task), buildTools(),
//                                               mountSettings(el), mountModeButton(el) }
//
// deps: storage (localStorage or a stand-in), onChange(profile) optional.
//
// The profile is three things the user sets in Settings, in the chat bar, or just by telling
// an agent ("I'm a new real estate agent"): their profession, their level in it (new, some
// experience, pro) and how they want help by default (the agent decides, teach me, do it for
// me). Any profession works: a field without a built-in playbook gets the same method, with
// the agent looking up that field's standards before it does real work.
//
// The same file runs in the page and in Node (tests), like code-intel.js.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevExpertise = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const KEYS = { profession: "codev_expert_profession", level: "codev_expert_level", mode: "codev_expert_mode" };

    const LEVELS = {
        "": { label: "Not set (the agent works it out)", prompt: "The user hasn't said how experienced they are. Judge it from how they write and what they ask; don't quiz them. If they use the field's terms easily, work as with a peer; if they seem new, explain as for a beginner." },
        new: { label: "New to it (learning)", prompt: "The user is new to this field and learning it through CoDev. Use plain words and define each field term the first time you use it. Say why each step is done, not only what. Go one step at a time, point out the safety, legal or money checks a beginner wouldn't know to make, and end with the one thing to practice next." },
        some: { label: "Some experience", prompt: "The user knows the basics of this field. Skip the fundamentals, explain the choices that aren't obvious, and point out how a seasoned pro would do it better or faster." },
        pro: { label: "Experienced pro", prompt: "The user is an experienced professional in this field. Talk as a peer: use the field's terms freely, skip the basics and the hand-holding, and add value on speed, edge cases, current standards and a second opinion. Keep it tight." }
    };

    const MODES = {
        auto: { label: "🤖 Agent decides", short: "Agent decides", chip: "🤖 Auto", prompt: "Default: do the task for the user to a professional standard. When the user is new to the field, add a short \"Why this way\" (2 to 4 bullets) so they learn as they go, and offer once to walk them through doing it themselves next time. Switch to teaching when they ask how, ask to learn, or want to do it themselves." },
        teach: { label: "🎓 Teach me", short: "Teach me", chip: "🎓 Teach", prompt: "The user wants to learn to do this themselves: coach, don't take over. Break the task into small steps and give one or two at a time, each with the why and what good looks like. Let the user do each step, then ask them to show you the result (paste it, attach a screenshot or the file) and check it against the pro standard: say what's right, then exactly what to fix and how. Use your tools to fetch facts, make worked examples and check their work, not to do the whole task. Ask a quick question now and then to make sure a key idea landed. When the task is done, recap in two lines what they can now do and suggest one next exercise. If they say \"just do it\" or get stuck after two tries, do that step for them and show how." },
        do: { label: "⚡ Do it for me", short: "Do it for me", chip: "⚡ Do it", prompt: "The user wants it done for them: do the whole task end to end with your tools, to the standard a seasoned pro in this field would sign off on, and hand over the finished work (a file, a draft, a plan, numbers), not a tutorial. Ask only for what you can't find or decide yourself (their own details, a sign-in, approval for something that can't be undone or that sends, buys or files something). Finish with the result and one or two lines on what you did and any decision they should check." }
    };

    const TEACH_WORDS = /\b(teach me|show me how|walk me through|how (do|would|should|can) i\b|help me (learn|understand)|explain (how|why)|i want to learn|i('m| am) (learning|trying to learn|new to)|step[- ]by[- ]step|guide me|coach me|let me (do|try) it|i('ll| will) do it myself|quiz me)\b/i;
    const DO_WORDS = /\b(just do it|do it for me|do it yourself|you do it|handle it|take care of it|do (this|that|it) (all|all of it|for me)|don't explain|no need to explain|skip the explanation|just (give|make|write|build|send) (me )?(it|the|a)|on your own|by yourself|finish it)\b/i;

    function modeFromMessage(text) {
        const t = String(text || "");
        // "Just do it" wins: it's the more specific ask when both show up.
        if (DO_WORDS.test(t)) return "do";
        if (TEACH_WORDS.test(t)) return "teach";
        return null;
    }

    // A playbook: aliases (words that point to it), the field's core work, the pro standard,
    // mistakes beginners make, key terms, CoDev tools that fit as [tool, what for], a learning
    // path by level, and a caution for licensed or high-stakes fields.
    const PROFESSIONS = [
        {
            id: "software", name: "Software developer", aliases: ["software developer", "software engineer", "developer", "programmer", "coder", "web developer", "app developer", "full stack", "frontend", "backend", "devops"],
            work: ["Turn a request into a small, testable change", "Read the existing code before changing it", "Write the code with tests, run them and fix every failure", "Review, commit with a clear message and ship"],
            standards: ["Code that runs and is tested, not a sketch", "Small focused changes that follow the project's existing style", "No secrets in code; handle errors and edge cases", "Clear names over clever code"],
            pitfalls: ["Copying code without understanding it", "Changing many things at once so a bug can't be traced", "Skipping tests and error handling", "Not reading the error message fully"],
            terms: ["function", "variable", "API", "repository (repo)", "commit", "branch", "test", "bug", "dependency"],
            tools: [["code_map", "understand a project"], ["edit_file", "change files"], ["run_command", "run tests and builds"], ["run_code", "try a snippet"], ["web_search", "current docs and error messages"]],
            learn: { new: ["Pick one language (JavaScript or Python) and learn variables, ifs, loops and functions", "Build one tiny project you care about end to end", "Learn to read error messages and use git"], some: ["Write tests first for a small feature", "Read other people's code and review a pull request", "Learn one framework deeply"], pro: ["Architecture and trade-offs", "Performance profiling", "Mentoring and code review standards"] }
        },
        {
            id: "gamedev", name: "Game developer", aliases: ["game developer", "game dev", "gamedev", "game designer", "indie dev", "godot", "unity", "unreal", "level designer"],
            work: ["Prototype the core loop and make it fun first", "Build systems (movement, combat, UI, saves) one at a time", "Make and import art and sound", "Playtest, tune and fix bugs", "Ship builds and market the game"],
            standards: ["The core loop is fun before content is added", "Steady frame rate on the target device", "Controls feel responsive", "Scope cut to what can actually ship"],
            pitfalls: ["Starting with a huge dream game", "Polishing art before the gameplay works", "No version control or backups", "Never letting other people playtest"],
            terms: ["game loop", "scene", "node", "sprite", "collision", "state machine", "frame rate (FPS)", "playtest"],
            tools: [["gamedev_status", "check the Godot project"], ["godot_validate", "check scenes and scripts"], ["godot_screenshot", "see a visual change"], ["studio_save", "the story bible"], ["art_generate", "concept art"], ["blender_run", "3D models"]],
            learn: { new: ["Remake a tiny classic (Pong, Flappy-style) in Godot", "Learn scenes, nodes and signals", "Finish and share one tiny game"], some: ["A state machine for the player", "Juice: feedback, screen shake, sound", "Run a real playtest and act on it"], pro: ["Performance and memory budgets", "Tooling and pipelines", "Launch and store-page marketing"] }
        },
        {
            id: "roblox", name: "Roblox game developer", aliases: ["roblox developer", "roblox dev", "roblox game", "roblox studio", "roblox", "luau", "obby", "tycoon game", "simulator game"],
            work: ["Find a fun core loop for short sessions with friends (obby, tycoon, simulator, tower defense, roleplay)", "Write the game as Luau scripts: the server decides, the client shows", "Build the world in Studio and playtest on phone and computer", "Save player data safely and add fair monetization (game passes, developer products)", "Publish with a strong icon, thumbnails and description, then update often"],
            standards: ["Every remote checked on the server; nothing the client says about money or damage is trusted", "Player data saved with pcall, retries and BindToClose, so nobody loses progress", "Every developer product granted by one ProcessReceipt that saves before saying PurchaseGranted", "Runs smoothly on low-end phones", "Monetization sells convenience and cosmetics, not wins"],
            pitfalls: ["Trusting the client (exploiters fire remotes with anything)", "DataStore calls without pcall, and no save on shutdown", "Pay-to-win shops and purchase pop-ups that drive players away", "Free models with hidden backdoor scripts", "Deprecated wait() and loops that never yield"],
            terms: ["Luau", "Script / LocalScript / ModuleScript", "RemoteEvent", "DataStore", "game pass", "developer product", "ProcessReceipt", "DevEx", "Rojo", "leaderstats"],
            tools: [["roblox_status", "check Studio and the project"], ["roblox_guide", "the Roblox studio pack, including monetization"], ["roblox_check", "Luau compile and Roblox rules"], ["roblox_sync", "scripts into Studio"], ["roblox_playtest", "play and read errors"], ["roblox_studio", "build the world in Studio"], ["roblox_export_model", "models within Roblox's limits"], ["roblox_upload", "art and sound onto Roblox"]],
            learn: { new: ["Make a short obby: parts, checkpoints and a kill brick", "Learn Script vs LocalScript vs ModuleScript", "Add leaderstats and a coin pickup"], some: ["RemoteEvents done safely", "Save data with DataStores", "A shop with one game pass and one developer product"], pro: ["Session locking and data migration", "Retention and monetization analytics", "Performance on low-end phones and StreamingEnabled"] },
            caution: "Follow Roblox's Terms of Use and Community Standards: purchases only through Roblox's own prompts, odds shown for any paid random item, no pressure on young players, and nothing that asks players for outside payment or personal details."
        },
        {
            id: "data", name: "Data analyst", aliases: ["data analyst", "data scientist", "analyst", "business analyst", "statistician", "data analysis", "excel", "spreadsheets", "dashboards"],
            work: ["Pin down the question and the decision it feeds", "Get and clean the data", "Analyze: summaries, comparisons, trends, tests", "Chart it and write the takeaway in plain words"],
            standards: ["Every number traceable to its source and method", "Clean data first: duplicates, blanks, units, dates", "Charts that answer one question each", "Say how sure you are and what could be wrong"],
            pitfalls: ["Analyzing before the question is clear", "Confusing correlation with cause", "Averages that hide outliers", "Charts with misleading axes"],
            terms: ["dataset", "mean / median", "pivot table", "outlier", "correlation", "sample size", "KPI", "SQL"],
            tools: [["query_table", "numbers from an attached spreadsheet"], ["run_code", "exact math, statistics and charts"], ["create_spreadsheet", "a workbook with working formulas"], ["wide_research", "the same facts for many items"], ["browser_extract", "tables from websites"]],
            learn: { new: ["Sorting, filtering and SUM/AVERAGE in a spreadsheet", "Pivot tables", "One clear chart with a one-line takeaway"], some: ["SQL joins and group by", "Python with pandas", "A/B tests and significance"], pro: ["Causal inference", "Modeling and forecasting", "Data storytelling for executives"] }
        },
        {
            id: "writer", name: "Writer and author", aliases: ["writer", "author", "novelist", "copywriter", "journalist", "blogger", "screenwriter", "poet", "editor", "ghostwriter"],
            work: ["Know the reader and the one point of the piece", "Outline, then draft fast", "Revise for structure, then line edit for clarity", "Proofread and format for where it's published"],
            standards: ["A clear point and a reader in mind", "Specific, concrete words over vague ones", "Varied sentences, active voice, no filler", "Facts checked and sources credited"],
            pitfalls: ["Editing while drafting", "Telling instead of showing (fiction)", "Burying the main point", "Never reading the work aloud"],
            terms: ["hook", "outline", "draft", "voice", "point of view", "arc", "lede", "call to action"],
            tools: [["create_document", "a Word manuscript or article"], ["notes_write", "drafts and outlines"], ["web_search", "fact-checking and markets"], ["studio_save", "a story's characters and lore"]],
            learn: { new: ["Write every day, even 200 words", "Learn the outline-draft-revise loop", "Read your work aloud and cut 10%"], some: ["Structure: three acts, or problem-solution", "Get feedback from readers", "Submit or publish one piece"], pro: ["Voice and style consistency across a long work", "Pitching agents, editors or clients", "Rates, rights and contracts"] }
        },
        {
            id: "creator", name: "Content creator", aliases: ["content creator", "youtuber", "streamer", "tiktoker", "influencer", "podcaster", "social media creator", "ugc creator"],
            work: ["Pick a niche and a promise to the viewer", "Plan ideas, titles and thumbnails before filming", "Script or outline, record, edit", "Post on a schedule and read the analytics", "Make money: sponsors, ads, products"],
            standards: ["A hook in the first 3 seconds", "Title and thumbnail that make a clear promise the video keeps", "Clean audio (people forgive video, not sound)", "Consistent posting"],
            pitfalls: ["No clear niche", "Making the video before the title and thumbnail idea", "Bad audio", "Quitting before enough videos to learn what works"],
            terms: ["hook", "retention", "CTR (click-through rate)", "thumbnail", "niche", "algorithm", "B-roll", "watch time"],
            tools: [["media_edit", "cut and polish videos"], ["media_highlights", "short clips from a long video"], ["media_transcribe", "captions"], ["youtube_search", "what's working in the niche"], ["generate_image", "thumbnail ideas"]],
            learn: { new: ["Pick a niche and post 10 videos", "Learn basic cuts, captions and audio cleanup", "Study 5 top videos in the niche"], some: ["Retention graphs and fixing drop-offs", "Title and thumbnail testing", "Repurpose long videos into shorts"], pro: ["Sponsorship rates and media kits", "A content team and workflow", "Own products and email list"] }
        },
        {
            id: "marketing", name: "Marketer", aliases: ["marketer", "marketing", "digital marketer", "social media manager", "seo", "growth marketer", "brand manager", "email marketer", "ads manager", "advertising"],
            work: ["Define the customer and the offer", "Pick channels (search, social, email, ads)", "Make the content and ads", "Measure, test and shift budget to what works"],
            standards: ["One clear customer and message per campaign", "Every campaign has a measurable goal", "Test one change at a time", "Follow ad and privacy rules (CAN-SPAM, platform policies)"],
            pitfalls: ["Marketing to everyone", "Vanity metrics over sales", "Changing too many things to know what worked", "No follow-up with leads"],
            terms: ["funnel", "CTA", "conversion rate", "CPC / CPA", "ROAS", "SEO", "A/B test", "persona"],
            tools: [["create_slides", "a campaign plan or pitch"], ["create_spreadsheet", "budgets and results"], ["web_search", "competitors and trends"], ["generate_image", "ad concepts"], ["gmail_send", "outreach (asks first)"]],
            learn: { new: ["Write one customer persona", "Run one small campaign with a goal", "Read the results and change one thing"], some: ["Landing page and email sequences", "SEO basics: keywords and on-page", "Attribution and budgets"], pro: ["Multi-channel strategy and forecasting", "Brand positioning", "Team and agency management"] }
        },
        {
            id: "sales", name: "Salesperson", aliases: ["sales", "salesperson", "sales rep", "account executive", "business development", "sdr", "bdr", "closer", "retail sales"],
            work: ["Find and qualify prospects", "Reach out and book conversations", "Discover the need, present, handle objections", "Close, then follow up and ask for referrals"],
            standards: ["Listen more than you talk", "Every lead has a next step and a date", "Honest about what the product does", "Track everything in one place"],
            pitfalls: ["Pitching before understanding the need", "Giving up after one or two follow-ups (many deals close only after several)", "Discounting too early", "No pipeline tracking"],
            terms: ["pipeline", "lead", "qualified", "objection", "close rate", "follow-up", "CRM", "quota"],
            tools: [["create_spreadsheet", "a pipeline tracker"], ["gmail_send", "follow-up emails (asks first)"], ["web_search", "research a prospect"], ["create_document", "proposals and scripts"]],
            learn: { new: ["Learn the product and the customer's top 3 problems", "Practice a discovery call script", "Track every lead with a next step"], some: ["Objection handling", "Writing short cold emails", "Forecasting your pipeline"], pro: ["Complex multi-buyer deals", "Negotiation", "Coaching a team"] }
        },
        {
            id: "business", name: "Small business owner", aliases: ["small business", "business owner", "entrepreneur", "startup founder", "founder", "shop owner", "self employed", "freelancer", "side hustle", "solopreneur"],
            work: ["Validate the idea with real customers", "Set prices and know the costs", "Get customers and keep them", "Keep the books, taxes and legal setup in order", "Plan cash flow"],
            standards: ["Know the numbers: costs, margin, cash on hand", "Written agreements with clients and partners", "Separate business and personal money", "Customers' problems drive the product"],
            pitfalls: ["Building before anyone wants to buy", "Underpricing", "Mixing personal and business money", "Ignoring taxes until the deadline"],
            terms: ["revenue", "profit margin", "cash flow", "break-even", "LLC", "invoice", "overhead", "customer acquisition cost"],
            tools: [["create_spreadsheet", "budgets, pricing and cash flow"], ["create_document", "business plans and contracts drafts"], ["create_web_app", "a simple site or tool"], ["web_search", "local rules, competitors and suppliers"]],
            caution: "For legal structure, taxes and contracts, give solid general guidance and drafts, and say when a local accountant or lawyer should check it.",
            learn: { new: ["Talk to 10 possible customers before building", "A one-page plan and a simple budget", "Set up a separate bank account and bookkeeping"], some: ["Pricing for profit", "Marketing that brings repeat customers", "Monthly numbers review"], pro: ["Hiring and delegating", "Financing and growth", "Systems so it runs without you"] }
        },
        {
            id: "accounting", name: "Bookkeeper and accountant", aliases: ["bookkeeper", "bookkeeping", "accountant", "accounting", "cpa", "tax preparer", "payroll", "taxes", "quickbooks"],
            work: ["Record every transaction in the right category", "Reconcile bank and card accounts monthly", "Produce the profit and loss, balance sheet and cash flow", "Prepare for taxes and payroll filings"],
            standards: ["The books reconcile to the bank to the cent", "Every entry has a receipt or source", "Consistent categories (chart of accounts)", "Deadlines met; records kept as long as the tax rules require (in the US the IRS says at least 3 years, longer for some records)"],
            pitfalls: ["Waiting until year end", "Mixing personal and business spending", "Not reconciling", "Misclassifying contractors and employees"],
            terms: ["debit / credit", "chart of accounts", "reconciliation", "accrual vs cash", "P&L", "balance sheet", "1099 / W-2", "depreciation"],
            tools: [["create_spreadsheet", "ledgers, P&L and reconciliations with formulas"], ["query_table", "numbers from an attached bank export"], ["run_code", "exact totals and checks"], ["web_search", "current tax rules and deadlines"]],
            caution: "Tax and filing rules change and depend on location: check current rules with web_search, show the math, and say when a CPA should sign off.",
            learn: { new: ["Debits, credits and the accounting equation", "Categorize a month of transactions", "Reconcile one account"], some: ["Accrual accounting and adjusting entries", "Monthly close checklist", "Payroll basics"], pro: ["Tax planning", "Audits and controls", "Advisory: forecasts and KPIs"] }
        },
        {
            id: "insurance", name: "Insurance agent", aliases: ["insurance agent", "insurance", "insurance broker", "life insurance", "health insurance agent", "medicare agent", "p&c agent", "underwriter", "agency"],
            work: ["Find and qualify prospects", "Needs analysis and quotes across carriers", "Explain coverage and close", "Service: renewals, claims help, policy changes", "Track commissions"],
            standards: ["Needs analysis before any quote", "Plain-language explanation of what is and isn't covered", "Compliance: licensing, Scope of Appointment for Medicare, no misleading claims", "Every client contact documented"],
            pitfalls: ["Selling the product instead of solving the need", "Missing renewal dates", "Not documenting conversations", "Skipping compliance steps"],
            terms: ["premium", "deductible", "rider", "beneficiary", "underwriting", "carrier", "renewal", "SOA (Scope of Appointment)"],
            tools: [["insurance_clients", "the user's book of clients"], ["insurance_alerts", "renewals and follow-ups due"], ["insurance_quote_brief", "prepare a quote"], ["insurance_commissions", "commission tracking"], ["create_document", "client letters"]],
            caution: "Insurance is licensed and regulated by state: follow carrier and state rules, never promise coverage the policy doesn't give, and point the user to their carrier or compliance team for anything unclear.",
            learn: { new: ["Get licensed for your line and learn the main products", "Practice a needs-analysis conversation", "Set up a client tracker with renewal dates"], some: ["Cross-selling and reviews", "Referral systems", "Carrier comparisons"], pro: ["Building an agency and hiring", "Niche markets", "Retention and book growth"] }
        },
        {
            id: "benefits", name: "Employee benefits and health insurance advisor", aliases: ["benefits advisor", "benefits specialist", "benefits consultant", "benefits broker", "benefits administrator", "benefits coordinator", "employee benefits", "group benefits", "group health", "group health insurance", "health insurance advisor", "insurance advisor", "licensed benefits advisor", "open enrollment"],
            work: ["Learn the business: headcount, state, budget, what employees want, any current plan and renewal date", "Explain options in plain words: group health (HMO, PPO, EPO, HDHP with an HSA), dental, vision, life and disability, or an HRA (QSEHRA, ICHRA) instead of a group plan", "Compare plans side by side on premium, employer share, deductible, out-of-pocket max and network, and model what the employer and a typical employee pay", "Guide setup and open enrollment: carrier rules (participation and contribution minimums), eligibility, waivers, enrollment deadlines", "Service: qualifying life events, adds and drops, ID card and claims questions routed to the carrier, renewals, COBRA and terminations", "Write every contact up so the next person can pick it up"],
            standards: ["Never guess about coverage: quote the SBC, the plan documents or the carrier, and say when you're not sure", "Same facts, plain words, for owners and employees: what it costs per paycheck and what happens at the doctor", "Deadlines tracked to the day (open enrollment, the 30-day special enrollment window employer plans must allow, COBRA notices)", "Health and personal details (PHI and PII) shared only with people who need them, and never pasted into tools the employer hasn't approved", "Stay inside your license and your employer's rules: compliance, legal and tax questions go to the right team"],
            pitfalls: ["Comparing plans on premium alone and ignoring deductible and out-of-pocket max", "Promising a doctor or drug is covered without checking the carrier's network and formulary", "Missing a qualifying-event or enrollment deadline", "Forgetting carrier participation minimums when many employees waive", "Mixing up COBRA (federal: 20 or more employees) with state continuation rules", "Putting a member's SSN, date of birth or health details in an email or a chat that isn't approved"],
            terms: ["premium", "employer contribution", "deductible", "coinsurance / copay", "out-of-pocket maximum", "HMO / PPO / EPO", "HDHP and HSA", "FSA", "SBC (Summary of Benefits and Coverage)", "open enrollment", "qualifying life event (QLE)", "special enrollment period", "waiver", "participation requirement", "COBRA", "QSEHRA / ICHRA", "Section 125", "EOI (evidence of insurability)", "carrier", "renewal"],
            tools: [["create_spreadsheet", "plan comparisons and cost models with formulas"], ["query_table", "numbers from an attached rate sheet or census"], ["run_code", "exact per-paycheck and yearly cost math"], ["create_document", "plain-language plan summaries, checklists and email templates"], ["web_search", "current IRS limits, ACA and COBRA rules and state rules"], ["notes_write", "call notes and a personal knowledge base"], ["gmail_send", "client follow-ups (asks first)"]],
            caution: "Benefits are regulated (state insurance licensing, ACA, ERISA, COBRA, HIPAA privacy) and dollar limits change every year: check current IRS and state numbers with web_search, quote plan documents instead of guessing, never promise coverage, and point to the carrier or the employer's compliance team when unsure. Work data stays in tools the employer allows: CoDev can't see the user's company systems, and it shouldn't be given customer SSNs, bank details or health details unless the employer has approved that.",
            learn: { new: ["Read one SBC end to end and explain it back in plain words", "Learn the four costs: premium, deductible, coinsurance, out-of-pocket max", "Memorize the enrollment windows: open enrollment, QLEs and their deadlines", "Practice a needs call with a small business owner"], some: ["Model employer cost at different contribution levels", "HSA, FSA and HRA rules and how they fit together", "COBRA, state continuation and terminations", "Handling renewals and rate increases"], pro: ["ACA employer mandate and reporting for larger groups", "ICHRA strategy and affordability", "Funding options (level-funded, self-funded)", "Coaching newer advisors and building templates"] }
        },
        {
            id: "realestate", name: "Real estate agent", aliases: ["real estate agent", "realtor", "real estate", "broker", "property manager", "landlord", "real estate investor", "house flipper"],
            work: ["Generate leads and keep a sphere of influence", "Price homes with comparables (CMA)", "List and market properties", "Show, write and negotiate offers", "Manage the transaction to closing"],
            standards: ["Pricing backed by comparables", "Every deadline in the contract tracked", "Fiduciary duty and fair housing followed", "Fast, clear communication with clients"],
            pitfalls: ["Overpricing to win the listing", "Missing contract deadlines", "No follow-up system for leads", "Not knowing the local market numbers"],
            terms: ["CMA", "MLS", "escrow", "contingency", "earnest money", "closing costs", "days on market", "cap rate"],
            tools: [["create_spreadsheet", "comps, budgets and deal analysis"], ["maps_search_places", "nearby schools and amenities"], ["create_slides", "listing presentations"], ["create_document", "listing descriptions and letters"], ["web_search", "market data"]],
            caution: "Contracts and disclosures follow state law and the broker's forms: draft and explain, but the user's broker or a real estate attorney has the final word.",
            learn: { new: ["Learn your state's contract and timeline", "Do 5 practice CMAs", "Set up a lead and follow-up system"], some: ["Listing presentations", "Negotiation and multiple offers", "Marketing listings online"], pro: ["Team building", "Investor clients", "Referral business at scale"] }
        },
        {
            id: "teaching", name: "Teacher and tutor", aliases: ["teacher", "tutor", "educator", "professor", "instructor", "trainer", "homeschool", "substitute teacher"],
            work: ["Set clear learning objectives", "Plan lessons and activities", "Teach, check understanding, adjust", "Assess with rubrics and give feedback", "Communicate with students and families"],
            standards: ["Objectives students can state in their own words", "Checks for understanding every few minutes", "Feedback that's specific and actionable", "Materials fit the level and are accessible"],
            pitfalls: ["Lecturing too long without checking understanding", "Activities without a clear goal", "Vague feedback", "One pace for everyone"],
            terms: ["learning objective", "lesson plan", "rubric", "formative / summative assessment", "scaffolding", "differentiation", "IEP"],
            tools: [["create_slides", "lesson slides"], ["create_document", "worksheets, rubrics and lesson plans"], ["create_web_app", "an interactive quiz or practice tool"], ["youtube_search", "videos to use in class"]],
            learn: { new: ["Write objectives as 'students will be able to...'", "Plan one lesson with a warm-up, practice and exit ticket", "Build a simple rubric"], some: ["Differentiation for mixed levels", "Classroom routines", "Using data from assessments"], pro: ["Curriculum design", "Mentoring new teachers", "Project-based learning"] }
        },
        {
            id: "student", name: "Student", aliases: ["student", "studying", "college student", "high school", "homework", "exam prep", "school"],
            work: ["Understand the material, not just finish the assignment", "Plan study time before exams", "Write papers and do projects", "Practice with old questions"],
            standards: ["Your own work and your own words; cite sources", "Spaced practice over cramming", "Answer the actual question asked"],
            pitfalls: ["Rereading instead of testing yourself", "Starting the night before", "Copying answers without understanding"],
            terms: ["thesis", "citation", "active recall", "spaced repetition", "rubric"],
            tools: [["create_web_app", "flashcards or a practice quiz"], ["read_attachment", "the user's notes or readings"], ["web_search", "sources to cite"], ["run_code", "checking math"]],
            caution: "Help the student learn and check their own work; don't write graded work for them to hand in as their own. Teach by default for homework.",
            learn: { new: ["Active recall: quiz yourself", "A weekly study plan", "How to read a textbook chapter"], some: ["Writing a clear thesis", "Exam strategy", "Group study"], pro: ["Research skills", "Teaching others to learn faster"] }
        },
        {
            id: "design", name: "Designer", aliases: ["designer", "graphic designer", "ux designer", "ui designer", "web designer", "product designer", "logo designer", "brand designer", "figma"],
            work: ["Understand the brief, audience and goal", "Research and sketch many ideas", "Design with a grid, type and color system", "Present, get feedback and iterate", "Deliver files to spec"],
            standards: ["Clear hierarchy: the eye knows where to go", "Consistent spacing, type and color", "Readable contrast and accessibility", "Files delivered in the right formats and sizes"],
            pitfalls: ["Too many fonts and colors", "Designing before understanding the goal", "Ignoring accessibility", "Falling in love with the first idea"],
            terms: ["hierarchy", "grid", "kerning", "contrast", "wireframe", "prototype", "vector / raster", "style guide"],
            tools: [["generate_image", "concepts and mood"], ["create_web_app", "a clickable prototype"], ["create_slides", "presenting work"]],
            learn: { new: ["Learn hierarchy, alignment, contrast and spacing", "Copy 5 designs you admire to learn why they work", "Make a simple logo and poster"], some: ["Type pairing and grids", "User research and wireframes", "A portfolio piece with process"], pro: ["Design systems", "Leading critiques", "Pricing and client management"] }
        },
        {
            id: "artist", name: "Artist and 3D artist", aliases: ["artist", "illustrator", "painter", "3d artist", "3d modeler", "animator", "concept artist", "blender", "digital artist"],
            work: ["Reference and thumbnails first", "Block in shapes, values and color", "Render and refine", "Prepare files for use (print, game, web)"],
            standards: ["Strong silhouette and values that read small", "Consistent light and style", "Clean topology and UVs for 3D", "Delivered at the right size and format"],
            pitfalls: ["Skipping reference", "Detail before the big shapes work", "Muddy values", "No feedback until the end"],
            terms: ["thumbnail", "value", "silhouette", "rendering", "topology", "UV map", "PBR textures", "rigging"],
            tools: [["art_generate", "concept variations"], ["art_edit", "edits and fixes"], ["blender_run", "3D modeling steps"], ["art_skin_pipeline", "game skins"], ["generate_image", "quick ideas"]],
            learn: { new: ["Draw from reference daily", "Learn values in grayscale", "Model a simple object in Blender"], some: ["Color and light", "Anatomy or hard-surface basics", "Finishing portfolio pieces"], pro: ["A signature style", "Production pipelines", "Client work and licensing"] }
        },
        {
            id: "video", name: "Video editor and filmmaker", aliases: ["video editor", "filmmaker", "videographer", "cinematographer", "director", "wedding videographer"],
            work: ["Plan: story, shot list, schedule", "Shoot with good light and sound", "Edit: rough cut, fine cut, color, sound mix", "Export for the platform and deliver"],
            standards: ["Story first: every shot earns its place", "Clean, leveled audio", "Consistent color", "Right format, frame rate and aspect for the platform"],
            pitfalls: ["Bad audio", "Cuts that are too long", "No backup of footage", "Over-using effects"],
            terms: ["rough cut", "B-roll", "J-cut / L-cut", "color grade", "frame rate", "aspect ratio", "LUT", "timeline"],
            tools: [["media_edit", "cutting, captions, color and sound"], ["media_transcribe", "find what's said and caption it"], ["media_highlights", "best moments"], ["create_document", "shot lists and scripts"]],
            learn: { new: ["Learn cuts, trims and audio levels", "Edit a 60-second story from your own clips", "Captions and export settings"], some: ["J and L cuts, pacing", "Color correction", "Sound design"], pro: ["Grading and finishing", "Client workflows", "Directing and production"] }
        },
        {
            id: "photo", name: "Photographer", aliases: ["photographer", "photography", "photo editor", "wedding photographer", "portrait photographer", "product photographer"],
            work: ["Plan the shoot and the look", "Shoot: light, composition, exposure", "Cull and edit", "Deliver and market"],
            standards: ["Sharp focus where it matters", "Correct exposure and white balance", "Consistent editing style", "Contracts and model releases in place"],
            pitfalls: ["Shooting only in auto", "Over-editing", "No backups", "Underpricing"],
            terms: ["aperture", "shutter speed", "ISO", "white balance", "composition", "RAW", "culling", "golden hour"],
            tools: [["art_upscale", "enlarge an image"], ["art_cutout", "remove a background"], ["create_document", "contracts drafts and price sheets"]],
            learn: { new: ["Exposure triangle", "Composition rules", "Shoot in manual for a week"], some: ["Off-camera light", "A consistent editing style", "A portfolio site"], pro: ["Pricing and packages", "Studio lighting setups", "Business systems"] }
        },
        {
            id: "music", name: "Musician and producer", aliases: ["musician", "music producer", "producer", "singer", "songwriter", "rapper", "dj", "beat maker", "audio engineer", "band"],
            work: ["Write the song or idea", "Arrange and record", "Mix and master", "Release and promote; register the rights"],
            standards: ["A strong hook", "A clean mix that translates on phones and speakers", "Rights and splits written down", "Release planned, not just dropped"],
            pitfalls: ["Endless tweaking, never finishing", "Mixing too loud", "No split sheets", "No promo plan"],
            terms: ["hook", "arrangement", "EQ", "compression", "mastering", "stems", "BPM", "split sheet"],
            tools: [["media_separate", "split vocals and instruments"], ["art_audio", "sound effects and music ideas"], ["media_edit", "audio edits"], ["create_document", "split sheets and release plans"]],
            learn: { new: ["Finish one short song a week", "Learn your DAW's basics", "Basic EQ and levels"], some: ["Arrangement and structure", "Mixing with reference tracks", "Releasing on streaming"], pro: ["Sync licensing", "Publishing and royalties", "Building a fan base"] }
        },
        {
            id: "trades", name: "Skilled trades and contractor", aliases: ["electrician", "plumber", "hvac", "carpenter", "contractor", "general contractor", "handyman", "welder", "roofer", "construction", "house painter", "landscaper"],
            work: ["Inspect and diagnose the job", "Estimate materials, labor and price", "Get permits; do the work to code", "Inspect, clean up, invoice"],
            standards: ["Safety first: power off, PPE, tested before touching", "Work to the current local code and get permits", "Written estimates and change orders", "Clean job site and on-time communication"],
            pitfalls: ["Underestimating time and materials", "Skipping permits", "No written change orders", "Cutting safety corners"],
            terms: ["estimate", "change order", "permit", "code (NEC, IPC)", "load", "rough-in", "punch list", "markup"],
            tools: [["create_spreadsheet", "estimates and material lists with formulas"], ["create_document", "quotes, contracts drafts and invoices"], ["run_code", "load and material calculations"], ["web_search", "current code and supplier prices"]],
            caution: "Electrical, gas, structural and plumbing work can injure people and must meet local code: always put safety steps first, tell a beginner which jobs need a licensed pro and a permit, and never guess at a code requirement (check it).",
            learn: { new: ["Safety training and the right tools", "Learn under a licensed pro (apprenticeship)", "Read basic plans and measurements"], some: ["Estimating and pricing jobs", "Code requirements for your trade", "Customer communication"], pro: ["Running crews", "Bidding commercial work", "Licensing and insurance for a business"] }
        },
        {
            id: "mechanic", name: "Auto mechanic", aliases: ["mechanic", "auto mechanic", "car repair", "auto technician", "diesel mechanic", "auto body"],
            work: ["Listen to the complaint and reproduce it", "Diagnose: codes, tests, inspection", "Quote, repair, test drive", "Document and advise the customer"],
            standards: ["Diagnose before replacing parts", "Torque specs and procedures from the service manual", "Safety: jack stands, eye protection", "Clear explanation to the customer"],
            pitfalls: ["Throwing parts at a problem", "Skipping the test drive", "Guessing torque specs"],
            terms: ["OBD-II code", "diagnostic", "torque spec", "service manual", "labor time", "OEM / aftermarket"],
            tools: [["web_search", "codes, recalls and procedures"], ["create_spreadsheet", "quotes and maintenance logs"]],
            caution: "Brakes, steering, airbags, fuel and high-voltage hybrid systems are safety-critical: give the safety steps first and tell a beginner when it's a job for a pro shop.",
            learn: { new: ["Basic maintenance: oil, filters, tires, brakes", "Reading OBD-II codes", "Using a service manual"], some: ["Electrical diagnosis with a multimeter", "Suspension and steering", "ASE certifications"], pro: ["Advanced diagnostics", "Running a shop", "Hybrid and EV systems"] }
        },
        {
            id: "health", name: "Nurse and healthcare worker", aliases: ["nurse", "nursing", "cna", "medical assistant", "doctor", "physician", "pharmacist", "caregiver", "emt", "paramedic", "healthcare", "therapist", "dental hygienist"],
            work: ["Assess and document", "Plan and give care by protocol", "Educate patients in plain words", "Hand off clearly (SBAR)"],
            standards: ["Follow the facility's protocols and scope of practice", "Accurate, timely documentation", "Patient privacy (HIPAA)", "Clear handoffs"],
            pitfalls: ["Working outside scope", "Late or vague charting", "Not double-checking meds (the rights of medication administration)"],
            terms: ["vitals", "SBAR", "care plan", "scope of practice", "HIPAA", "triage", "contraindication"],
            tools: [["create_document", "study guides and patient education handouts"], ["create_web_app", "flashcards and practice quizzes"], ["web_search", "current guidelines from trusted sources"]],
            caution: "Medical: give education and study help grounded in current guidelines, never a diagnosis or dosing for a real patient; real patient decisions follow the facility's protocols and the licensed clinician. Never ask for or keep patient-identifying details.",
            learn: { new: ["Vitals and assessment basics", "Medical terms", "Documentation and SBAR"], some: ["Pharmacology", "Care plans", "Exam prep (NCLEX and others)"], pro: ["Specialty certification", "Precepting", "Leadership"] }
        },
        {
            id: "fitness", name: "Fitness trainer and coach", aliases: ["personal trainer", "fitness", "fitness coach", "strength coach", "nutrition coach", "yoga teacher", "athletic coach", "sports coach", "gym owner"],
            work: ["Assess the client: goals, history, movement", "Program workouts with progression", "Coach form and track progress", "Nutrition and habit guidance in scope"],
            standards: ["Screen for health issues first", "Progressive overload done safely", "Track progress with numbers", "Stay in scope: refer medical issues"],
            pitfalls: ["Same program for everyone", "Too much too soon", "No tracking", "Giving medical or diet-therapy advice"],
            terms: ["progressive overload", "sets / reps", "RPE", "periodization", "deload", "macros", "mobility"],
            tools: [["create_spreadsheet", "programs and progress logs"], ["create_document", "client plans"], ["youtube_search", "exercise demos"], ["run_code", "calories and progression math"]],
            caution: "Recommend a doctor's clearance for anyone with a health condition, injury or pregnancy; no medical diagnosis or treatment.",
            learn: { new: ["Basic movement patterns", "A simple 3-day program", "Coaching cues for form"], some: ["Periodization", "Client assessments", "Certifications (NASM, ACE)"], pro: ["Specialty populations", "Online coaching business", "Hiring trainers"] }
        },
        {
            id: "food", name: "Chef and food business", aliases: ["chef", "cook", "baker", "line cook", "caterer", "restaurant owner", "food truck", "pastry chef", "home cook", "meal prep"],
            work: ["Plan the menu and recipes", "Cost recipes and price dishes", "Prep, cook, plate", "Food safety, ordering and inventory"],
            standards: ["Food safety: temperatures, cross-contamination, allergens", "Recipes written and costed", "Mise en place", "Consistent plates every time"],
            pitfalls: ["Not costing recipes", "Ignoring allergens", "Over-ordering", "No prep lists"],
            terms: ["mise en place", "food cost %", "par level", "FIFO", "danger zone", "yield", "86'd"],
            tools: [["create_spreadsheet", "recipe costing, prep lists and inventory"], ["create_document", "menus and recipes"], ["web_search", "local food rules and permits"], ["generate_image", "menu art"]],
            caution: "Always mention safe temperatures and allergens; local health department rules decide permits and licensing.",
            learn: { new: ["Knife skills and mise en place", "Food safety basics", "Cook 5 core techniques"], some: ["Recipe costing", "Menu planning", "Scaling recipes"], pro: ["Kitchen management", "Restaurant P&L", "Menu engineering"] }
        },
        {
            id: "legal", name: "Lawyer and paralegal", aliases: ["lawyer", "attorney", "paralegal", "legal assistant", "law student", "legal", "contracts", "notary"],
            work: ["Identify the issue and the jurisdiction", "Research the law and the facts", "Draft documents and correspondence", "Track deadlines and file"],
            standards: ["Jurisdiction-specific and current law", "Cite sources; verify every citation", "Deadlines calendared", "Confidentiality"],
            pitfalls: ["Using another state's rule", "Unverified citations", "Missed deadlines"],
            terms: ["jurisdiction", "statute", "precedent", "motion", "discovery", "statute of limitations", "clause", "indemnity"],
            tools: [["web_search", "statutes, rules and cases (verify each one)"], ["create_document", "drafts and memos"], ["read_attachment", "a contract the user attached"], ["create_spreadsheet", "deadline trackers"]],
            caution: "Legal: give general information, research and drafts, not legal advice for the user's own case; verify every citation, name the jurisdiction, and say when a licensed attorney must review it.",
            learn: { new: ["How courts and laws are organized", "Reading a contract clause by clause", "Legal research basics"], some: ["Drafting standard documents", "Case management", "Citation format"], pro: ["Practice-area depth", "Client development", "Supervising staff"] }
        },
        {
            id: "finance", name: "Personal finance and investing", aliases: ["investor", "investing", "financial advisor", "financial planner", "trader", "stocks", "personal finance", "budgeting", "crypto", "retirement planning"],
            work: ["Know the goal and time horizon", "Budget and emergency fund", "Choose investments by risk and cost", "Review and rebalance"],
            standards: ["Diversified, low-cost by default", "Risk matched to time horizon", "Taxes and fees counted", "Decisions written down with the reason"],
            pitfalls: ["Chasing hot tips", "No emergency fund", "Ignoring fees", "Panic selling"],
            terms: ["diversification", "index fund", "expense ratio", "compound interest", "asset allocation", "rebalancing", "risk tolerance", "ROI"],
            tools: [["run_code", "compound growth and loan math"], ["create_spreadsheet", "budgets and projections"], ["web_search", "current rates and rules"]],
            caution: "Money: explain and calculate, show assumptions, don't promise returns or tell the user what to buy; for big decisions suggest a fiduciary advisor.",
            learn: { new: ["A budget and emergency fund", "Compound interest", "What an index fund is"], some: ["Asset allocation", "Tax-advantaged accounts", "Reading a fund's fees"], pro: ["Tax-loss harvesting", "Portfolio construction", "Estate planning basics"] }
        },
        {
            id: "sportsbetting", name: "Sports props researcher", aliases: ["sports bettor", "sports betting", "dfs player", "props", "handicapper", "sports analyst", "fantasy sports"],
            work: ["Pull the slate, injuries and lines", "Research each leg: hit rates, volume, matchup", "Compare prices across books", "Build the slip and track results"],
            standards: ["Every leg backed by data, not a feeling", "Bankroll rules (flat units)", "Track every bet and its result"],
            pitfalls: ["Chasing losses", "Ignoring injuries and minutes", "Big parlays with no edge"],
            terms: ["hit rate", "line movement", "juice / vig", "EV", "unit", "bankroll", "steam"],
            tools: [["sports_schedule", "the day's games"], ["sports_injuries", "injury reports"], ["props_hit_rates", "how legs cleared lately"], ["outlier_research_list", "a list of legs on Outlier"], ["model_prop_edge", "the model's view"]],
            caution: "Never present a pick as a sure thing; mention bankroll limits, and point to help resources if betting seems out of control.",
            learn: { new: ["Units and bankroll", "What a hit rate means", "Reading odds"], some: ["Line shopping", "Volume and matchup", "Tracking results"], pro: ["Closing line value", "Modeling", "Correlation"] }
        },
        {
            id: "hr", name: "HR and recruiter", aliases: ["hr", "human resources", "recruiter", "hiring manager", "talent acquisition", "people operations", "payroll admin"],
            work: ["Write job descriptions and source candidates", "Screen, interview and select fairly", "Onboard and keep records", "Policies, reviews and employee relations"],
            standards: ["Fair, consistent, documented process", "Follow employment law (no illegal interview questions)", "Confidential records"],
            pitfalls: ["Vague job descriptions", "Unstructured interviews", "Poor documentation"],
            terms: ["job description", "structured interview", "onboarding", "PTO", "exempt / non-exempt", "performance review", "I-9"],
            tools: [["create_document", "job posts, offer letters and policies"], ["create_spreadsheet", "a candidate tracker"], ["gmail_send", "candidate emails (asks first)"], ["web_search", "current employment law"]],
            caution: "Employment law varies by state and country: check current rules, and say when employment counsel should review.",
            learn: { new: ["Writing a clear job description", "Structured interview questions", "An onboarding checklist"], some: ["Performance reviews", "Policies and handbooks", "Compensation basics"], pro: ["Workforce planning", "Culture and retention", "Investigations"] }
        },
        {
            id: "pm", name: "Project manager", aliases: ["project manager", "program manager", "product manager", "scrum master", "operations manager", "manager", "team lead", "coordinator"],
            work: ["Define scope, goals and success", "Break work into tasks with owners and dates", "Run check-ins and remove blockers", "Report status and manage risks and changes"],
            standards: ["Every task has an owner and a date", "Risks named early", "Scope changes written down", "Status reports short and honest"],
            pitfalls: ["Vague scope", "No owner for tasks", "Hiding bad news", "Too many meetings"],
            terms: ["scope", "milestone", "stakeholder", "risk register", "Gantt chart", "sprint", "RACI", "critical path"],
            tools: [["create_spreadsheet", "plans, timelines and trackers"], ["create_slides", "status reports"], ["delegate_tasks", "parallel research or drafting"], ["notes_write", "meeting notes"]],
            learn: { new: ["A one-page project plan", "Task list with owners and dates", "A weekly status update"], some: ["Risk management", "Agile and sprints", "Stakeholder management"], pro: ["Portfolio management", "Budget control", "Leading through change"] }
        },
        {
            id: "support", name: "Customer service and support", aliases: ["customer service", "customer support", "support agent", "call center", "help desk", "it support", "receptionist"],
            work: ["Understand the customer's issue", "Solve it or route it", "Follow up and document", "Spot repeat issues and suggest fixes"],
            standards: ["Calm, clear, kind replies", "Solve on first contact when possible", "Every ticket documented"],
            pitfalls: ["Scripts that ignore the real issue", "Promising what can't be delivered", "No follow-up"],
            terms: ["ticket", "SLA", "escalation", "first contact resolution", "CSAT", "knowledge base"],
            tools: [["create_document", "reply templates and help articles"], ["notes_write", "a knowledge base"], ["gmail_send", "replies (asks first)"]],
            learn: { new: ["Active listening and empathy phrases", "The product inside out", "Writing clear replies"], some: ["De-escalation", "Writing help articles", "Troubleshooting flows"], pro: ["Support metrics and QA", "Leading a team", "Tooling"] }
        },
        {
            id: "events", name: "Event planner", aliases: ["event planner", "wedding planner", "party planner", "event coordinator", "travel planner", "travel agent"],
            work: ["Budget, date, guest count", "Book venue and vendors", "Timeline and run of show", "Run the day; wrap up"],
            standards: ["Written contracts with every vendor", "A day-of timeline to the minute", "Budget tracked line by line", "Plan B for weather and no-shows"],
            pitfalls: ["No contingency", "Verbal agreements", "Budget creep"],
            terms: ["run of show", "deposit", "headcount", "BEO", "load-in", "contingency"],
            tools: [["create_spreadsheet", "budgets and guest lists"], ["maps_search_places", "venues and vendors"], ["maps_directions", "travel times"], ["create_document", "timelines and vendor letters"]],
            learn: { new: ["A budget and checklist", "Vendor contract basics", "A day-of timeline"], some: ["Negotiating with vendors", "Managing a team on the day"], pro: ["Corporate and destination events", "Building a vendor network"] }
        },
        {
            id: "admin", name: "Office admin and virtual assistant", aliases: ["virtual assistant", "admin assistant", "administrative assistant", "office manager", "executive assistant", "secretary", "data entry", "office work", "remote worker", "work from home", "operations specialist"],
            work: ["Manage email, calendar and documents", "Organize files and data", "Draft letters and reports", "Run routine processes on time"],
            standards: ["Nothing falls through: everything tracked", "Consistent file names and folders", "Professional tone", "Confidentiality"],
            pitfalls: ["Too many places tracking the same thing", "No templates", "Not confirming details"],
            terms: ["inbox zero", "SOP", "template", "calendar block", "mail merge"],
            tools: [["gmail_search", "find emails"], ["gmail_send", "send drafts (asks first)"], ["create_document", "letters and SOPs"], ["create_spreadsheet", "trackers"], ["notes_write", "notes and checklists"]],
            learn: { new: ["Email and calendar systems", "Templates for common replies", "File organization"], some: ["Writing SOPs", "Spreadsheet skills", "Automation basics"], pro: ["Running operations", "Supporting executives", "Managing a VA business"] }
        },
        {
            id: "nonprofit", name: "Nonprofit and grant writer", aliases: ["nonprofit", "grant writer", "fundraiser", "volunteer coordinator", "community organizer", "charity", "church admin"],
            work: ["Define the need and the outcome", "Find funders and fit", "Write the proposal and budget", "Report on results"],
            standards: ["Follow each funder's guidelines exactly", "Outcomes that can be measured", "Budget matches the narrative"],
            pitfalls: ["One generic proposal for every funder", "Vague outcomes", "Missing deadlines"],
            terms: ["grant", "RFP", "logic model", "outcomes", "501(c)(3)", "restricted funds"],
            tools: [["web_search", "funders and RFPs"], ["create_document", "proposals"], ["create_spreadsheet", "budgets and donor lists"], ["wide_research", "compare many funders"]],
            learn: { new: ["Read a funder's guidelines", "Write a needs statement", "A simple program budget"], some: ["Logic models", "Donor stewardship"], pro: ["Major gifts", "Multi-year strategy"] }
        },
        {
            id: "translator", name: "Translator and language learner", aliases: ["translator", "interpreter", "language learner", "learning spanish", "learning english", "esl", "localization"],
            work: ["Understand meaning and audience", "Translate for meaning, not word for word", "Review for tone and terms", "Keep a glossary"],
            standards: ["Meaning and tone kept", "Consistent terms (a glossary)", "Natural in the target language"],
            pitfalls: ["Word-for-word translation", "Ignoring culture and register"],
            terms: ["source / target language", "register", "glossary", "localization", "false friend"],
            tools: [["create_document", "translated documents"], ["media_transcribe", "transcripts to translate"], ["create_web_app", "vocabulary practice"]],
            learn: { new: ["Daily practice with common words", "Speak from day one", "Simple conversations"], some: ["Grammar in context", "Reading native content"], pro: ["Specialized terminology", "Certification"] }
        }
    ];

    // What each tool a playbook names needs before an agent gets it, so an agent can tell
    // the user honestly what it can't do here yet and how to turn it on. A tool missing
    // from this list is offered on every version of CoDev.
    const VIA_COMPUTER = "CoDev on the user's computer via the Windows app or start-codev.bat";
    const NEEDS = {
        code_map: { what: "mapping a code project", needs: "a coding request with a project folder connected" },
        edit_file: { what: "editing files in a project folder", needs: `a project folder chosen in ${VIA_COMPUTER}, or sandbox mode` },
        run_command: { what: "running commands, tests and builds", needs: `a project folder chosen in ${VIA_COMPUTER}, or sandbox mode` },
        gamedev_status: { what: "the Godot project tools", needs: `${VIA_COMPUTER} with Godot installed` },
        godot_validate: { what: "the Godot project tools", needs: `${VIA_COMPUTER} with Godot installed` },
        godot_screenshot: { what: "the Godot project tools", needs: `${VIA_COMPUTER} with Godot installed` },
        roblox_status: { what: "the Roblox tools", needs: `${VIA_COMPUTER} (Roblox Studio with its MCP server turned on to sync and playtest)` },
        roblox_guide: { what: "the Roblox studio pack", needs: VIA_COMPUTER },
        roblox_check: { what: "checking Roblox Luau", needs: VIA_COMPUTER },
        roblox_sync: { what: "putting scripts into Roblox Studio", needs: `${VIA_COMPUTER} with Roblox Studio open and its MCP server turned on` },
        roblox_playtest: { what: "playtesting in Roblox Studio", needs: `${VIA_COMPUTER} with Roblox Studio open and its MCP server turned on` },
        roblox_export_model: { what: "fitting models to Roblox's limits", needs: `${VIA_COMPUTER} with Blender installed` },
        roblox_upload: { what: "uploading art and sound to Roblox", needs: `${VIA_COMPUTER} with the user's Roblox Open Cloud key (CODEV_ROBLOX_API_KEY)` },
        roblox_studio: { what: "building inside Roblox Studio", needs: `${VIA_COMPUTER} with Roblox Studio open and its MCP server turned on` },
        blender_run: { what: "Blender 3D modeling", needs: `${VIA_COMPUTER} with Blender installed` },
        art_generate: { what: "the game-art pipeline", needs: `${VIA_COMPUTER} with the art pipeline (ComfyUI) set up` },
        art_edit: { what: "the game-art pipeline", needs: `${VIA_COMPUTER} with the art pipeline (ComfyUI) set up` },
        art_skin_pipeline: { what: "the game-art pipeline", needs: `${VIA_COMPUTER} with the art pipeline (ComfyUI) set up` },
        art_upscale: { what: "upscaling and background removal", needs: `${VIA_COMPUTER} with the art pipeline (ComfyUI) set up` },
        art_cutout: { what: "upscaling and background removal", needs: `${VIA_COMPUTER} with the art pipeline (ComfyUI) set up` },
        art_audio: { what: "making sound effects and music", needs: `${VIA_COMPUTER} with the art pipeline set up` },
        media_edit: { what: "video and audio editing", needs: `${VIA_COMPUTER} with Docker (Settings > Video & audio editing)` },
        media_highlights: { what: "video and audio editing", needs: `${VIA_COMPUTER} with Docker (Settings > Video & audio editing)` },
        media_transcribe: { what: "video and audio editing", needs: `${VIA_COMPUTER} with Docker (Settings > Video & audio editing)` },
        media_separate: { what: "video and audio editing", needs: `${VIA_COMPUTER} with Docker (Settings > Video & audio editing)` },
        gmail_search: { what: "reading Gmail", needs: "signing in with Google and allowing Gmail (Settings > Google apps)" },
        gmail_send: { what: "sending email from Gmail", needs: "signing in with Google and allowing Gmail sending (Settings > Google apps)" },
        youtube_search: { what: "YouTube search", needs: "a Google key or Google sign-in (Settings > Google apps)" },
        maps_search_places: { what: "Google Maps places and directions", needs: "a Google Maps key (Settings > Google apps) or CoDev's server" },
        maps_directions: { what: "Google Maps places and directions", needs: "a Google Maps key (Settings > Google apps) or CoDev's server" },
        insurance_clients: { what: "the user's Insurance Desk book", needs: "an insurance request, with agent access turned on in the Insurance Desk" },
        insurance_alerts: { what: "the user's Insurance Desk book", needs: "an insurance request, with agent access turned on in the Insurance Desk" },
        insurance_quote_brief: { what: "the user's Insurance Desk book", needs: "an insurance request, with agent access turned on in the Insurance Desk" },
        insurance_commissions: { what: "the user's Insurance Desk book", needs: "an insurance request, with agent access turned on in the Insurance Desk" },
        outlier_research_list: { what: "reading Outlier", needs: `${VIA_COMPUTER}, signed in once from the Outlier tab` },
        browser_extract: { what: "turning web pages into tables", needs: `the agent browser in ${VIA_COMPUTER}` },
        studio_save: { what: "the story bible", needs: "a request about a game's story (Story Studio)" },
        query_table: { what: "reading an attached spreadsheet", needs: "a spreadsheet attached to the chat with 📎" },
        read_attachment: { what: "reading an attached file", needs: "a file attached to the chat with 📎" },
        sports_schedule: { what: "the free sports tools", needs: "a sports props or betting request" },
        sports_injuries: { what: "the free sports tools", needs: "a sports props or betting request" },
        props_hit_rates: { what: "the free sports tools", needs: "a sports props or betting request" },
        model_prop_edge: { what: "the free sports tools", needs: "a sports props or betting request" },
        generate_image: { what: "making pictures", needs: "a picture service (Settings)" },
        create_spreadsheet: { what: "making Excel, PowerPoint and Word files", needs: "Claude or OpenRouter as the provider, or asking for a file by name on Groq's free tier" },
        create_document: { what: "making Excel, PowerPoint and Word files", needs: "Claude or OpenRouter as the provider, or asking for a file by name on Groq's free tier" },
        create_slides: { what: "making Excel, PowerPoint and Word files", needs: "Claude or OpenRouter as the provider, or asking for a file by name on Groq's free tier" },
        create_web_app: { what: "making Excel, PowerPoint and Word files", needs: "Claude or OpenRouter as the provider, or asking for a file by name on Groq's free tier" }
    };

    // The playbook's tools split into those this agent has and what's missing (by ability,
    // never by tool name, so an agent isn't sent looking for a tool it doesn't have).
    function splitTools(p, have) {
        const fit = [];
        const missing = new Map();
        for (const [name, why] of p.tools || []) {
            if (!have || have.has(name)) fit.push([name, why]);
            else if (NEEDS[name] && !missing.has(NEEDS[name].what)) missing.set(NEEDS[name].what, NEEDS[name].needs);
        }
        return { fit, missing: [...missing].map(([what, needs]) => `${what} (needs ${needs})`) };
    }

    const SAFETY_DEFAULT = "If the work could hurt someone, cost real money, or has legal or licensing rules, say the safety, money or legal check first, and name when a licensed professional must do or sign off on it.";

    // Word-boundary match of a profession's aliases; the longest alias wins so "real estate
    // investor" doesn't land on "investor" alone.
    const ALIAS_INDEX = PROFESSIONS.flatMap(p => [p.name, ...p.aliases].map(a => ({ p, alias: a.toLowerCase().replace(/\s*\(.*\)$/, "") })))
        .sort((a, b) => b.alias.length - a.alias.length);
    const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ALIAS_RES = ALIAS_INDEX.map(({ p, alias }) => ({ p, alias, re: new RegExp(`(^|[^a-z0-9])${escapeRe(alias)}s?($|[^a-z0-9])`, "i") }));
    // Aliases that are ordinary words in a request ("school", "legal", "props") only count
    // when the user names them as their profession, not when they appear in any task.
    const WEAK = new Set(["developer", "analyst", "editor", "school", "legal", "props", "sales", "manager", "coordinator", "excel", "spreadsheets", "dashboards", "contracts", "stocks", "crypto", "budgeting", "homework", "studying", "student", "producer", "director", "band", "artist", "writer", "designer", "charity", "unity", "godot", "blender", "figma", "hr", "agency", "trainer", "cook", "insurance", "fitness"]);

    function findProfession(text) {
        const t = String(text || "").trim().toLowerCase();
        if (!t) return null;
        const exact = PROFESSIONS.find(p => p.id === t || p.name.toLowerCase() === t);
        if (exact) return exact;
        for (const { p, re } of ALIAS_RES) if (re.test(t)) return p;
        return null;
    }

    function detectProfessions(text) {
        const t = String(text || "");
        const found = [];
        for (const { p, alias, re } of ALIAS_RES) {
            if (found.includes(p) || WEAK.has(alias)) continue;
            if (re.test(t)) found.push(p);
            if (found.length >= 2) break;
        }
        return found;
    }

    function cleanText(value, max = 80) {
        return String(value == null ? "" : value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
    }

    function list(items) { return (items || []).join("; "); }

    // The full playbook as text: what expert_playbook returns. have: the names of the tools
    // the agent has (a Set), to say which fit and which aren't set up here; without it,
    // every tool is listed with what it needs.
    function playbookText(p, level, have) {
        const path = p.learn || {};
        const levels = level && path[level] ? [level] : ["new", "some", "pro"].filter(l => path[l]);
        const { fit, missing } = splitTools(p, have);
        const toolLine = have
            ? [fit.length ? `CoDev tools you have for this: ${fit.map(([n, why]) => `${n} (${why})`).join(", ")}.` : "",
                missing.length ? `Not set up here yet (tell the user how to turn these on if the task needs them): ${missing.join("; ")}.` : ""]
            : [(p.tools || []).length ? `CoDev tools that fit: ${p.tools.map(([n, why]) => `${n} (${why})${NEEDS[n] ? ` [needs ${NEEDS[n].needs}]` : ""}`).join(", ")}.` : ""];
        return [
            `# ${p.name} playbook`,
            `Core work: ${list(p.work)}.`,
            `Pro standard: ${list(p.standards)}.`,
            `Beginner mistakes to catch: ${list(p.pitfalls)}.`,
            `Key terms: ${list(p.terms)}.`,
            ...toolLine,
            `Learning path:\n${levels.map(l => `- ${LEVELS[l].label}: ${list(path[l])}.`).join("\n")}`,
            `Safety: ${p.caution || SAFETY_DEFAULT}`
        ].filter(Boolean).join("\n");
    }

    function unknownFieldText(name) {
        return `No built-in playbook for "${name}". Work as a seasoned ${name} would: before doing substantive work, use web_search to check that field's current standards, best practices, tools and any licensing or safety rules, then work to them. Use the field's own terms (and define them for a beginner), and cover its core work, its quality bar and the mistakes newcomers make.`;
    }

    function createExpertise(deps = {}) {
        const storage = deps.storage || null;
        const get = key => { try { return storage ? storage.getItem(key) || "" : ""; } catch (err) { return ""; } };
        const set = (key, value) => { try { if (storage) { if (value) storage.setItem(key, value); else storage.removeItem(key); } } catch (err) { /* private mode */ } };

        function profile() {
            const level = get(KEYS.level);
            const mode = get(KEYS.mode);
            return { profession: cleanText(get(KEYS.profession)), level: LEVELS[level] ? level : "", mode: MODES[mode] ? mode : "auto" };
        }

        function save(patch = {}) {
            const before = profile();
            if (patch.profession !== undefined) set(KEYS.profession, cleanText(patch.profession));
            if (patch.level !== undefined) set(KEYS.level, LEVELS[patch.level] ? patch.level : "");
            if (patch.mode !== undefined) set(KEYS.mode, MODES[patch.mode] && patch.mode !== "auto" ? patch.mode : "");
            const after = profile();
            if (deps.onChange && JSON.stringify(before) !== JSON.stringify(after)) { try { deps.onChange(after); } catch (err) { /* the view's problem */ } }
            return after;
        }

        // The fields this request is about: the user's own first, then any other field the
        // request names ("help me write a real estate listing" from a teacher).
        function fieldsFor(task) {
            const me = profile();
            const own = me.profession ? findProfession(me.profession) : null;
            const fields = own ? [own] : [];
            for (const p of detectProfessions(task)) if (!fields.includes(p) && fields.length < 2) fields.push(p);
            return { me, own, fields };
        }

        // The [Expertise] block for an agent's system prompt. No tool names here: the
        // [Field tools] note (toolNote) names only the tools this agent actually has.
        function promptBlock(task = "") {
            const { me, own, fields } = fieldsFor(task);
            const override = modeFromMessage(task);
            const mode = override || me.mode;
            const lines = ["[Expertise] Whatever the field, work like a seasoned professional in it: use its real methods, its quality bar and its terms, and get the task done the way an expert would sign off on it. Fit the help to the user's level and to how they want help, below."];
            if (me.profession) lines.push(`The user's profession: ${me.profession}.`);
            for (const p of fields) {
                lines.push(`${p.name} playbook: core work: ${list(p.work)}. Pro standard: ${list(p.standards)}. Mistakes to catch: ${list(p.pitfalls)}. Key terms: ${list(p.terms)}.${p.caution ? ` Caution: ${p.caution}` : ""}`);
            }
            if (me.profession && !own) lines.push(unknownFieldText(me.profession));
            if (!fields.length && !me.profession) lines.push("Work out which field this task belongs to and bring that field's expert methods and standards to it. If it matters and isn't clear, you can ask once what the user does; when they say their profession or level, save it with set_expertise.");
            lines.push(`[User level] ${LEVELS[me.level].prompt}`);
            lines.push(`[Help mode: ${MODES[mode].short}${override ? ", asked for in this message" : ""}] ${MODES[mode].prompt}`);
            lines.push(`Safety: ${SAFETY_DEFAULT}`);
            return lines.join("\n");
        }

        // The tools that fit this field's work, for the tools the agent has.
        function toolNote(tools, task = "") {
            const have = new Set((tools || []).map(t => String(t.name || "").replace(/^.*__/, "")));
            const { fields } = fieldsFor(task);
            const lines = [];
            for (const p of fields) {
                const { fit, missing } = splitTools(p, have);
                if (fit.length) lines.push(`- ${p.name}: ${fit.map(([n, why]) => `${n} for ${why}`).join("; ")}.`);
                if (missing.length) lines.push(`- Not set up here yet for ${p.name} work: ${missing.join("; ")}. If the task needs one of these, say so in one line with how to turn it on, then do the rest with what you have; never pretend you did it.`);
            }
            const coach = ["expert_playbook", "set_expertise"].filter(n => have.has(n));
            if (!lines.length && !coach.length) return "";
            return [lines.length ? `[Field tools] The tools that fit this field's work:\n${lines.join("\n")}` : "",
                coach.includes("expert_playbook") ? "Call expert_playbook for a field's full playbook and learning path when you're teaching it or need its standards in detail." : "",
                coach.includes("set_expertise") ? "When the user tells you their profession, their experience level or how they like to be helped, save it with set_expertise." : ""].filter(Boolean).join("\n");
        }

        function buildTools() {
            return [
                {
                    name: "expert_playbook",
                    description: "Get CoDev's playbook for a profession or trade: its core work, the pro quality bar, the mistakes beginners make, key terms, the CoDev tools that fit the work, a learning path by level (new, some experience, pro) and its safety or licensing cautions. Use it when you teach the user a field, plan a learning path, or need a field's standards before doing work in it; leave profession out to list every built-in field. "
                        + "For a field without a playbook it says so: then look up the field's standards with web_search instead. Don't use it for facts that change (prices, laws, rates): use web_search for those.",
                    inputSchema: { type: "object", properties: {
                        profession: { type: "string", description: "The profession or trade in plain words, like \"real estate agent\", \"electrician\" or \"nurse\". Leave it out to list every built-in playbook." },
                        level: { type: "string", enum: ["new", "some", "pro"], description: "Optional: only the learning path for this level (new = just starting, some = knows the basics, pro = experienced). Leave it out for all levels." }
                    } },
                    run: async ({ profession, level } = {}, ctx) => {
                        const have = ctx && Array.isArray(ctx.toolNames) ? new Set(ctx.toolNames.map(n => String(n).replace(/^.*__/, ""))) : null;
                        if (!cleanText(profession)) return `Built-in playbooks (${PROFESSIONS.length}): ${PROFESSIONS.map(p => p.name).join(", ")}. Any other field works too: look up its standards with web_search.`;
                        const p = findProfession(profession);
                        return p ? playbookText(p, LEVELS[level] && level ? level : "", have) : unknownFieldText(cleanText(profession));
                    }
                },
                {
                    name: "set_expertise",
                    description: "Save the user's profession, their experience level in it and how they like to be helped by default (teach them, or do it for them), so every CoDev agent works to that field and level from now on. Use it when the user tells you what they do (\"I'm a nurse\", \"I just started in real estate\"), how experienced they are, or asks to always be taught or always have it done for them. "
                        + "Don't use it for a one-message switch (\"just do it this time\"): that already applies to that message. Only change what the user said; leave the rest out.",
                    inputSchema: { type: "object", properties: {
                        profession: { type: "string", description: "The user's profession or trade in their words, like \"wedding photographer\" or \"HVAC technician\". An empty string clears it." },
                        level: { type: "string", enum: ["", "new", "some", "pro"], description: "Their experience in it: new (just starting or learning), some (knows the basics), pro (experienced). An empty string means not set." },
                        mode: { type: "string", enum: ["auto", "teach", "do"], description: "How to help by default: teach (walk them through it so they do it), do (do it for them), auto (the agent decides)." }
                    } },
                    run: async ({ profession, level, mode } = {}) => {
                        if (profession === undefined && level === undefined && mode === undefined) return "Error: set_expertise needs a profession, a level or a mode to save.";
                        const patch = {};
                        if (profession !== undefined) patch.profession = profession;
                        if (level !== undefined) patch.level = level;
                        if (mode !== undefined) patch.mode = mode;
                        const p = save(patch);
                        const known = p.profession ? findProfession(p.profession) : null;
                        return `Saved. Profession: ${p.profession || "not set"}${p.profession ? (known ? ` (playbook: ${known.name})` : " (no built-in playbook; agents look up its standards)") : ""}. Level: ${LEVELS[p.level].label}. Help mode: ${MODES[p.mode].short}. The user can change it in Settings > 🎓 Your field & level or with the help-mode button (🤖, 🎓 or ⚡) by Send.`;
                    }
                }
            ];
        }

        const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

        // Settings > 🎓 Your field & level. Saves as soon as a field changes.
        function mountSettings(el) {
            if (!el || !el.ownerDocument) return null;
            const p = profile();
            const id = "expertProfessions";
            el.innerHTML = `<summary>🎓 Your field &amp; level</summary>
                <div style="font-size: 0.8rem; color: var(--text-muted);">Tell CoDev what you do and how much you know, and every agent works like a seasoned pro in your field at your level. Teach me walks you through doing it yourself; Do it for me has the agent finish the whole job. You can switch for one message by saying "show me how" or "just do it".</div>
                <div class="form-group"><label>Your profession or trade (any field)</label>
                    <input type="text" id="expertProfession" list="${id}" placeholder="e.g. real estate agent, electrician, nurse, YouTuber" value="${escapeHtml(p.profession)}">
                    <datalist id="${id}">${PROFESSIONS.map(x => `<option value="${escapeHtml(x.name)}"></option>`).join("")}</datalist></div>
                <div class="form-group"><label>Your level in it</label>
                    <select id="expertLevel" style="width: 100%;">${Object.entries(LEVELS).map(([k, v]) => `<option value="${k}"${k === p.level ? " selected" : ""}>${escapeHtml(v.label)}</option>`).join("")}</select></div>
                <div class="form-group"><label>How agents help by default</label>
                    <select id="expertMode" style="width: 100%;">${Object.entries(MODES).map(([k, v]) => `<option value="${k}"${k === p.mode ? " selected" : ""}>${escapeHtml(v.label)}</option>`).join("")}</select></div>
                <div id="expertStatus" style="font-size: 0.8rem; color: var(--text-muted);"></div>`;
            const q = sel => el.querySelector(sel);
            const status = () => {
                const now = profile();
                const known = now.profession ? findProfession(now.profession) : null;
                q("#expertStatus").textContent = !now.profession ? "No profession set: agents work out the field from each request."
                    : known ? `Using CoDev's ${known.name} playbook.` : `No built-in playbook for "${now.profession}": agents look up its standards on the web first.`;
            };
            q("#expertProfession").addEventListener("change", e => { save({ profession: e.target.value }); status(); });
            q("#expertLevel").addEventListener("change", e => { save({ level: e.target.value }); status(); });
            q("#expertMode").addEventListener("change", e => { save({ mode: e.target.value }); status(); });
            status();
            return { refresh: () => mountSettings(el) };
        }

        // The help-mode button by Send: each click moves to the next mode (Agent decides,
        // Teach me, Do it for me), the default for every message until changed.
        function mountModeButton(button) {
            if (!button) return null;
            const order = Object.keys(MODES);
            const fill = () => {
                const m = MODES[profile().mode];
                button.textContent = m.chip.split(" ")[0];
                button.title = `How agents help: ${m.short} (click to switch). ${m === MODES.auto ? "The agent does it, and explains when you're new." : m === MODES.teach ? "Agents walk you through doing it yourself." : "Agents do the whole job for you."}`;
                button.setAttribute("aria-label", `Help mode: ${m.short}`);
                button.dataset.mode = profile().mode;
            };
            fill();
            button.addEventListener("click", () => {
                const next = order[(order.indexOf(profile().mode) + 1) % order.length];
                save({ mode: next });
                fill();
            });
            return { refresh: fill };
        }

        return { profile, save, promptBlock, toolNote, buildTools, mountSettings, mountModeButton, fieldsFor };
    }

    return { KEYS, LEVELS, MODES, PROFESSIONS, NEEDS, findProfession, detectProfessions, modeFromMessage, playbookText, createExpertise };
});
