// attached_assets/god-tier-music.js
const { execFile } = require('node:child_process');

const query = process.argv[2];
if (!query) {
    console.log(JSON.stringify({ error: "No query provided" }));
    process.exit(1);
}

function runCmd(cmd, args, timeout = 6000) {
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 10, timeout }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

async function getStream() {
    let activeProcesses = [];

    // 1. Audiomack (Primary)
    const audioPromise = new Promise(async (resolve, reject) => {
        try {
            console.error(`[Scraper] Trying Audiomack first...`);
            const out = await runCmd('yt-dlp', [`https://audiomack.com/search?q=${query}`, '--dump-json', '--flat-playlist']);
            const results = out.trim().split('\n').map(l => JSON.parse(l));
            if (results.length === 0) throw new Error("No Audio");
            
            const streamOut = await runCmd('yt-dlp', [results[0].url, '-f', 'bestaudio', '-g', '--no-playlist']);
            resolve({ url: streamOut.trim().split('\n')[0], source: 'Audiomack' });
        } catch (e) { reject(e); }
    });

    // 2. SoundCloud (Secondary)
    const soundPromise = new Promise(async (resolve, reject) => {
        try {
            console.error(`[Scraper] Trying SoundCloud...`);
            const out = await runCmd('yt-dlp', [`scsearch1:${query}`, '-f', 'bestaudio', '-g', '--no-playlist']);
            resolve({ url: out.trim().split('\n')[0], source: 'SoundCloud' });
        } catch (e) { reject(e); }
    });

    // 3. YouTube Custom Script (Last Resort, 3.5 second hard timeout)
    const ytPromise = new Promise((resolve, reject) => {
        console.error(`[Scraper] Trying YouTube...`);
        const child = execFile('node', [`./attached_assets/scrape-ytmusik_1793744644906.js`, query, '--stream', '1'], { timeout: 3500 }, (err, stdout) => {
            if (err) return reject(err);
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
        // Race them! Audiomack and SoundCloud start instantly.
        const winner = await Promise.any([audioPromise, soundPromise, ytPromise]);
        activeProcesses.forEach(p => { try { p.kill(); } catch(e) {} });
        
        // Print ONLY the JSON to stdout
        console.log(JSON.stringify({
            status: true,
            source: winner.source,
            results: {
                songs: [
                    {
                        id: winner.url, // Pass the direct URL as the ID
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
        console.log(JSON.stringify({ status: false, error: "Song not found on any platform." }));
    }
}

getStream();
