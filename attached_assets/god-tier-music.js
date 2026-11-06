// attached_assets/god-tier-music.js
const { execFile } = require('node:child_process');

const query = process.argv[2];
if (!query) {
    console.log(JSON.stringify({ status: false, error: "No query provided" }));
    process.exit(0);
}

function runCmd(cmd, args, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 10, timeout }, (error, stdout, stderr) => {
            if (error) {
                // Append stderr so the backend logs can see exactly why it failed
                error.message += ` | stderr: ${stderr}`;
                reject(error);
            }
            else resolve(stdout);
        });
    });
}

async function getStream() {
    let activeProcesses = [];

    // 1. Audiomack (Primary)
    const audioPromise = new Promise(async (resolve, reject) => {
        try {
            console.error(`[Scraper] Trying Audiomack...`);
            const out = await runCmd('yt-dlp', ['--quiet', '--no-warnings', `https://audiomack.com/search?q=${encodeURIComponent(query)}`, '--dump-json', '--flat-playlist'], 15000);
            const results = out.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
            if (results.length === 0) throw new Error("No Audio results");
            
            const streamOut = await runCmd('yt-dlp', ['--quiet', '--no-warnings', results[0].url, '-f', 'bestaudio', '-g', '--no-playlist'], 15000);
            resolve({ url: streamOut.trim().split('\n')[0], source: 'Audiomack' });
        } catch (e) { 
            console.error(`[Scraper] Audiomack failed: ${e.message}`);
            reject(e); 
        }
    });

    // 2. SoundCloud (Secondary)
    const soundPromise = new Promise(async (resolve, reject) => {
        try {
            console.error(`[Scraper] Trying SoundCloud...`);
            const out = await runCmd('yt-dlp', ['--quiet', '--no-warnings', `scsearch1:${query}`, '-f', 'bestaudio', '-g', '--no-playlist'], 15000);
            resolve({ url: out.trim().split('\n')[0], source: 'SoundCloud' });
        } catch (e) { 
            console.error(`[Scraper] SoundCloud failed: ${e.message}`);
            reject(e); 
        }
    });

    // 3. YouTube Custom Script (Last Resort)
    const ytPromise = new Promise((resolve, reject) => {
        console.error(`[Scraper] Trying YouTube...`);
        const child = execFile('node', [`./attached_assets/scrape-ytmusik_1793744644906.js`, query, '--stream', '1'], { timeout: 5000 }, (err, stdout, stderr) => {
            if (err) {
                console.error(`[Scraper] YouTube failed: ${err.message}`);
                return reject(err);
            }
            try {
                const data = JSON.parse(stdout);
                const url = data.results?.songs?.[0]?.streaming?.stream_url;
                if (url) resolve({ url, source: 'YouTube' });
                else reject(new Error('No URL'));
            } catch (e) { reject(e); }
        });
        activeProcesses.push(child);
    });

    try {
        // Wait for the first one to succeed
        const winner = await Promise.any([audioPromise, soundPromise, ytPromise]);
        activeProcesses.forEach(p => { try { p.kill(); } catch(e) {} });
        
        console.log(JSON.stringify({
            status: true,
            source: winner.source,
            results: {
                songs: [
                    {
                        id: winner.url, 
                        title: query,
                        creator: 'Music Artist',
                        watchUrl: winner.url,
                        streaming: { stream_url: winner.url }
                    }
                ]
            }
        }));
    } catch (error) {
        console.error(`[Scraper] All failed: ${error.message}`);
        console.log(JSON.stringify({ status: false, error: `Not found: ${error.message}` }));
    }
}

getStream();
