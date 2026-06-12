require('dotenv').config();
const fs = require('fs');

// Calculate dynamic CST campaign window (from 00:00 CST to current execution time)
function getCentralTimeWindow() {
    const end = new Date();
    
    // Calculate the dynamic millisecond offset between UTC and Chicago time
    const offsetMs = new Date(end.toLocaleString('en-US', { timeZone: 'America/Chicago' })) 
                     - new Date(end.toLocaleString('en-US', { timeZone: 'UTC' }));

    // Get the current date components as they appear in Chicago right now
    const chicagoNow = new Date(end.getTime() + offsetMs);
    
    // Target exact midnight (00:00:00) local Chicago time
    const startLocal = new Date(Date.UTC(
        chicagoNow.getUTCFullYear(),
        chicagoNow.getUTCMonth(),
        chicagoNow.getUTCDate(),
        0, 0, 0, 0
    ));

    // Convert the local midnight back to the proper global UTC time
    const start = new Date(startLocal.getTime() - offsetMs);

    return { startISO: start.toISOString(), endISO: end.toISOString() };
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

async function getCountryStats() {
    const credentials = { apiKey: process.env.GIGYA_API_KEY, userKey: process.env.GIGYA_USER_KEY, secretKey: process.env.GIGYA_SECRET_KEY };
    const campaign = 'EONEVRYCNR';

    if (!credentials.apiKey || !credentials.userKey || !credentials.secretKey) return console.error("Error: Missing env credentials.");
    const { startISO, endISO } = getCentralTimeWindow();

    const queries = {
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

    try {
        console.log(`Fetching: ${startISO} to ${endISO}...`);
        const queryKeys = Object.keys(queries);
        const responses = await Promise.all(queryKeys.map(key => queryGigya(queries[key], credentials)));

        const finalOutput = {};
        queryKeys.forEach((key, idx) => finalOutput[key] = parseResults(responses[idx].results, key));

        // Safely extract current time parts directly from America/Chicago timezone
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Chicago',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
        });
        const parts = formatter.formatToParts(new Date());
        const cst = Object.fromEntries(parts.map(p => [p.type, p.value]));
        
        // Constructs perfectly accurate strings: YYYY-MM-DD_HH-mm
        const timestamp = `${cst.year}-${cst.month}-${cst.day}_${cst.hour}-${cst.minute}`;
        const datePart = `${cst.year}-${cst.month}-${cst.day}`;
                
        finalOutput["lastUpdated"] = timestamp;

        if (!fs.existsSync('./data')) fs.mkdirSync('./data');
        
        fs.writeFileSync(`./data/crossbar-${timestamp}.json`, JSON.stringify(finalOutput, null, 2), 'utf-8'); // Hourly snapshot
        fs.writeFileSync(`./data/crossbar-${datePart}.json`, JSON.stringify(finalOutput, null, 2), 'utf-8'); // Daily tracking snapshot
        fs.writeFileSync(`./data/crossbar-latest.json`, JSON.stringify(finalOutput, null, 2), 'utf-8'); // Dashboard feed file
        console.log(`✅ Data files updated successfully (Central Time).`);
    } catch (error) {
        console.error("Execution error:", error);
    }
}

getCountryStats();