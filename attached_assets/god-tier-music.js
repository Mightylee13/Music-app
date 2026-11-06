// attached_assets/god-tier-music.js
const { execFile } = require('node:child_process');

const query = process.argv[2];
if (!query) {
    console.log(JSON.stringify({ error: "No query provided" }));
    process.exit(1);
}

function runCmd(cmd, args, timeout = 8000) {
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("Timeout"));
        }, timeout);
        child.on('close', () => clearTimeout(timer));
    });
}

async function getStream() {
    let activeProcesses = [];

    // 1. Try Audiomack FIRST
    const audioPromise = new Promise(async (resolve, reject) => {
        try {
            console.log(`[Scraper] Trying Audiomack first...`);
            const out = await runCmd('yt-dlp', [`https://audiomack.com/search?q=${query}`, '--dump-json', '--flat-playlist']);
            const results = out.trim().split('\n').map(l => JSON.parse(l));
            if (results.length === 0) throw new Error("No Audio");
            
            const streamOut = await runCmd('yt-dlp', [results[0].url, '-f', 'bestaudio', '-g', '--no-playlist']);
            resolve({ url: streamOut.trim().split('\n')[0], source: 'Audiomack' });
        } catch (e) { reject(e); }
    });

    // 2. Try SoundCloud SECOND
    const soundPromise = new Promise(async (resolve, reject) => {
        try {
            console.log(`[Scraper] Trying SoundCloud...`);
            const out = await runCmd('yt-dlp', [`scsearch1:${query}`, '-f', 'bestaudio', '-g', '--no-playlist']);
            resolve({ url: out.trim().split('\n')[0], source: 'SoundCloud' });
        } catch (e) { reject(e); }
    });

    // 3. Try YouTube LAST (Because Render blocks it)
    const ytPromise = new Promise((resolve, reject) => {
        console.log(`[Scraper] Trying YouTube...`);
        const child = execFile('node', [`./attached_assets/scrape-ytmusik_1793744644906.js`, query, '--stream', '1'], (err, stdout) => {
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

    // THE RACE: Audio & Sound start instantly. If they fail, YouTube kicks in.
    try {
        const winner = await Promise.any([audioPromise, soundPromise, ytPromise]);
        activeProcesses.forEach(p => { try { p.kill(); } catch(e) {} });
        
        console.log(JSON.stringify({
            status: true,
            source: winner.source,
            results: {
                songs: [
                    {
                        id: winner.url, // We pass the direct URL as the ID
                        title: query,
                        creator: 'Music Artist',
                        watchUrl: winner.url,
                        streaming: { stream_url: winner.url }
                    }
                ]
            }
        }));
    } catch (error) {
        console.log(JSON.stringify({ status: false, error: "Song not found on any platform." }));
    }
}

getStream();
