require('dotenv').config();
const fs = require('fs');

const CAMPAIGN_START = "2026-06-11";
const CAMPAIGN_END = "2026-07-19";
const CAMPAIGN_CODE = 'EONEVRYCNR';

// Helper to find exact UTC Date corresponding to 00:00:00 CST for any given date
function getCSTMidnight(date) {
    const offsetMs = new Date(date.toLocaleString('en-US', { timeZone: 'America/Chicago' })) 
                     - new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const chicagoNow = new Date(date.getTime() + offsetMs);
    const startLocal = new Date(Date.UTC(
        chicagoNow.getUTCFullYear(),
        chicagoNow.getUTCMonth(),
        chicagoNow.getUTCDate(),
        0, 0, 0, 0
    ));
    return new Date(startLocal.getTime() - offsetMs);
}

// Helper to format any date into YYYY-MM-DD in CST
function getCSTDateString(date) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = formatter.formatToParts(date);
    const cst = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${cst.year}-${cst.month}-${cst.day}`;
}

// Send query to Gigya accounts.search endpoint
async function queryGigya(query, credentials) {
    const response = await fetch("https://accounts.us1.gigya.com/accounts.search", {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ apiKey: credentials.apiKey, userKey: credentials.userKey, secret: credentials.secretKey, query })
    });
    return response.json();
}

// Parse and format Gigya response results
function parseResults(results, queryName) {
    if (!results || !Array.isArray(results) || results.length === 0) return 0;
    if (queryName.toLowerCase().includes('country') && results.length > 7) {
        console.error(`🚨 Error [${queryName}]: Expected max 7 countries, got ${results.length}.`);
    }
    if (results.length === 1 && !results[0]['profile.country']) return results[0]['count(*)'] || 0;

    return results.reduce((acc, item) => {
        const rawCountry = item['profile.country'];
        if (rawCountry) acc[rawCountry.includes(':') ? rawCountry.split(':').pop() : rawCountry] = item['count(*)'] || 0;
        return acc;
    }, {});
}

function generateQueries(campaign, startISO, endISO) {
    return {
        grandTotal: `SELECT count(*) FROM accounts WHERE (data.sourceCode.email.createIndividual = '${campaign}' AND created < '${endISO}') OR (data.sourceCode.email.updateIndividual = '${campaign}' AND lastUpdated < '${endISO}')`,
        grandTotalNew: `SELECT count(*) FROM accounts WHERE data.sourceCode.email.createIndividual = '${campaign}' AND created < '${endISO}'`,
        grandTotalUpdates: `SELECT count(*) FROM accounts WHERE (data.sourceCode.email.updateIndividual = '${campaign}' AND data.sourceCode.email.createIndividual != '${campaign}') AND lastUpdated < '${endISO}'`,
        grandTotalCountrySplit: `SELECT profile.country, count(*) FROM accounts WHERE (data.sourceCode.email.createIndividual = '${campaign}' AND created < '${endISO}') OR (data.sourceCode.email.updateIndividual = '${campaign}' AND lastUpdated < '${endISO}') GROUP BY profile.country`,
       
        dailyTotal: `SELECT count(*) FROM accounts WHERE ((data.sourceCode.email.createIndividual = '${campaign}' AND created >= '${startISO}' AND created < '${endISO}') OR (data.sourceCode.email.updateIndividual = '${campaign}' AND lastUpdated >= '${startISO}' AND lastUpdated < '${endISO}'))`,
        dailyTotalNew: `SELECT count(*) FROM accounts WHERE data.sourceCode.email.createIndividual = '${campaign}' AND created >= '${startISO}' AND created < '${endISO}'`,
        dailyTotalUpdates: `SELECT count(*) FROM accounts WHERE (data.sourceCode.email.updateIndividual = '${campaign}' AND data.sourceCode.email.createIndividual != '${campaign}') AND lastUpdated >= '${startISO}' AND lastUpdated < '${endISO}'`,
        dailyTotalCountrySplit: `SELECT profile.country, count(*) FROM accounts WHERE ((data.sourceCode.email.createIndividual = '${campaign}' AND created >= '${startISO}' AND created < '${endISO}') OR (data.sourceCode.email.updateIndividual = '${campaign}' AND lastUpdated >= '${startISO}' AND lastUpdated < '${endISO}')) GROUP BY profile.country`,
        dailyTotalNewCountrySplit: `SELECT profile.country, count(*) FROM accounts WHERE data.sourceCode.email.createIndividual = '${campaign}' AND created >= '${startISO}' AND created < '${endISO}' GROUP BY profile.country`,
        dailyTotalUpdatesCountrySplit: `SELECT profile.country, count(*) FROM accounts WHERE (data.sourceCode.email.updateIndividual = '${campaign}' AND data.sourceCode.email.createIndividual != '${campaign}') AND lastUpdated >= '${startISO}' AND lastUpdated < '${endISO}' GROUP BY profile.country`,
        
        grandTotalDeuNewOptInConfirmed: `SELECT count(*) FROM emailAccounts WHERE ((data.sourceCode.email.createIndividual = '${campaign}' AND created < '${endISO}') OR (data.sourceCode.email.updateIndividual = '${campaign}' AND lastUpdated < '${endISO}')) AND profile.country = "urn:com.ehi:prd:reference:location:country:DEU" AND subscriptions.ERAC_RENTAL_DOIEMAIL.email.isSubscribed = true`,
        dailyTotalDeuNewOptInConfirmed: `SELECT count(*) FROM emailAccounts WHERE (data.sourceCode.email.createIndividual = '${campaign}' AND created >= '${startISO}' AND created < '${endISO}') AND profile.country = "urn:com.ehi:prd:reference:location:country:DEU" AND subscriptions.ERAC_RENTAL_DOIEMAIL.email.isSubscribed = true`
    };
}

async function getCountryStats() {
    const credentials = { apiKey: process.env.GIGYA_API_KEY, userKey: process.env.GIGYA_USER_KEY, secretKey: process.env.GIGYA_SECRET_KEY };

    if (!credentials.apiKey || !credentials.userKey || !credentials.secretKey) return console.error("Error: Missing env credentials.");
    if (!fs.existsSync('./data')) fs.mkdirSync('./data');

    const now = new Date();
    const todayMidnight = getCSTMidnight(now);
    const todayStr = getCSTDateString(now);

    // ==========================================
    // PHASE 1: GENERATE COMPLETED PAST DAYS (00:00 to 24:00 CST)
    // ==========================================
    let loopDate = new Date(getCSTMidnight(new Date(`${CAMPAIGN_START}T12:00:00Z`)));
    
    while (loopDate < todayMidnight) {
        const loopStr = getCSTDateString(loopDate);
        const filePath = `./data/crossbar-${loopStr}.json`;

        if (loopStr >= CAMPAIGN_START && loopStr <= CAMPAIGN_END && !fs.existsSync(filePath)) {
            console.log(`Historical day finalized file missing for ${loopStr}. Generating full window (00:00 to 24:00 CST)...`);
            
            const startISO = getCSTMidnight(loopDate).toISOString();
            const nextDay = new Date(loopDate.getTime() + 24 * 60 * 60 * 1000);
            const endISO = getCSTMidnight(nextDay).toISOString();

            try {
                const queries = generateQueries(CAMPAIGN_CODE, startISO, endISO);
                const queryKeys = Object.keys(queries);
                const responses = await Promise.all(queryKeys.map(key => queryGigya(queries[key], credentials)));

                const finalOutput = {};
                queryKeys.forEach((key, idx) => finalOutput[key] = parseResults(responses[idx].results, key));

                finalOutput["lastUpdated"] = `${loopStr}_24-00`;
                fs.writeFileSync(filePath, JSON.stringify(finalOutput, null, 2), 'utf-8');
                console.log(`✅ Finalized daily snapshot saved: ${filePath}`);
            } catch (err) {
                console.error(`Error processing historical snapshot for ${loopStr}:`, err);
            }
        }
        loopDate = new Date(loopDate.getTime() + 24 * 60 * 60 * 1000);
    }

    // ==========================================
    // PHASE 2: GENERATE LIVE ONGOING METRICS (TODAY)
    // ==========================================
    if (todayStr >= CAMPAIGN_START && todayStr <= CAMPAIGN_END) {
        console.log(`Fetching current ongoing day metrics for ${todayStr}...`);
        const startISO = todayMidnight.toISOString();
        const endISO = now.toISOString();

        try {
            const queries = generateQueries(CAMPAIGN_CODE, startISO, endISO);
            const queryKeys = Object.keys(queries);
            const responses = await Promise.all(queryKeys.map(key => queryGigya(queries[key], credentials)));

            const finalOutput = {};
            queryKeys.forEach((key, idx) => finalOutput[key] = parseResults(responses[idx].results, key));

            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/Chicago',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false
            });
            const parts = formatter.formatToParts(now);
            const cst = Object.fromEntries(parts.map(p => [p.type, p.value]));
            
            const timestamp = `${cst.year}-${cst.month}-${cst.day}_${cst.hour}-${cst.minute}`;
            finalOutput["lastUpdated"] = timestamp;

            fs.writeFileSync(`./data/crossbar-${timestamp}.json`, JSON.stringify(finalOutput, null, 2), 'utf-8');
            fs.writeFileSync(`./data/crossbar-latest.json`, JSON.stringify(finalOutput, null, 2), 'utf-8');
            console.log(`✅ Live runtime dashboard tracking complete.`);
        } catch (error) {
            console.error("Execution error on live tracking data execution:", error);
        }
    } else {
        console.log(`Current calendar day (${todayStr}) sits outside the planned active window boundaries.`);
    }
}

getCountryStats();