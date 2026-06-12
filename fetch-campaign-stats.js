require('dotenv').config();
const fs = require('fs');

// Dynamiczne okno czasowe: od 4:00 AM CST bieżącego dnia do aktualnej godziny (co godzinę)
function getCentralTimeWindow() {
    const end = new Date(); // Aktualna data i godzina wykonania

    // Ustawienie początku na godzinę 10:00 UTC (4:00 AM CST) bieżącego dnia kalendarzowego
    const start = new Date(Date.UTC(
        end.getUTCFullYear(), 
        end.getUTCMonth(), 
        end.getUTCDate(), 
        10, 0, 0, 0
    ));

    // Jeśli aktualna godzina jest przed 10:00 UTC, dzień kampanii zaczął się wczoraj o 10:00 UTC
    if (end.getTime() < start.getTime()) {
        start.setUTCDate(start.getUTCDate() - 1);
    }

    return { 
        startISO: start.toISOString(), 
        endISO: end.toISOString() 
    };
}

// Helper function to send queries to Gigya's accounts.search endpoint
async function queryGigya(query, credentials) {
    const url = "https://accounts.us1.gigya.com/accounts.search";
    const payload = new URLSearchParams({
        apiKey: credentials.apiKey,
        userKey: credentials.userKey,
        secret: credentials.secretKey,
        query: query
    });

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload
    });

    return await response.json();
}

/**
 * Process AND format raw results from Gigya
 */
function parseResults(results, queryName) {
    if (!results || !Array.isArray(results) || results.length === 0) return 0;

    if (queryName.toLowerCase().includes('country') && results.length > 7) {
        console.error(`🚨 Error [${queryName}]: Expected up to 7 countries, but received ${results.length}.`);
    }

    if (results.length === 1 && !results[0]['profile.country']) {
        return results[0]['count(*)'] || 0;
    }

    const output = {};
    results.forEach(item => {
        const rawCountry = item['profile.country'];
        const count = item['count(*)'] || 0;
        
        if (rawCountry) {
            const countryName = rawCountry.includes(':') ? rawCountry.split(':').pop() : rawCountry;
            output[countryName] = count;
        }
    });

    return output;
}

async function getCountryStats() {
    const credentials = {
        apiKey: process.env.GIGYA_API_KEY,
        userKey: process.env.GIGYA_USER_KEY,
        secretKey: process.env.GIGYA_SECRET_KEY
    };
    const campaign = 'EONEVRYCNR';

    if (!credentials.apiKey || !credentials.userKey || !credentials.secretKey) {
        console.error("Error: Missing credentials in .env file.");
        return;
    }

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
        console.log(`Fetching registration window: ${startISO} to ${endISO}...`);

        const queryKeys = Object.keys(queries);
        const promises = queryKeys.map(key => queryGigya(queries[key], credentials));
        const responses = await Promise.all(promises);

        const finalOutput = {};
        queryKeys.forEach((key, index) => {
            finalOutput[key] = parseResults(responses[index].results, key);
        });

        const timestamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
        const datePart = timestamp.split('_')[0]; // YYYY-MM-DD
                
        finalOutput["lastUpdated"] = timestamp;

        const dir = './data';
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir);
        }
        
        // 1. Zapis pliku z unikalną godziną i minutą (cogodzinny snapshot)
        const fileName = `${dir}/crossbar-${timestamp}.json`;
        fs.writeFileSync(fileName, JSON.stringify(finalOutput, null, 2), 'utf-8');
        console.log(`✅ Successfully saved hourly snapshot to ${fileName}`);

        // 2. Zapis pliku dla konkretnego dnia (zapewnia poprawne działanie date-pickera)
        const dailyFileName = `${dir}/crossbar-${datePart}.json`;
        fs.writeFileSync(dailyFileName, JSON.stringify(finalOutput, null, 2), 'utf-8');
        console.log(`✅ Successfully updated daily cumulative file: ${dailyFileName}`);

        // 3. Stały plik z najnowszymi danymi (dla domyślnego ładowania tablic)
        const latestFileName = `${dir}/crossbar-latest.json`;
        fs.writeFileSync(latestFileName, JSON.stringify(finalOutput, null, 2), 'utf-8');
        console.log(`✅ Successfully updated latest stats in ${latestFileName}`);

    } catch (error) {
        console.error("An error occurred during script execution:", error);
    }
}

getCountryStats();