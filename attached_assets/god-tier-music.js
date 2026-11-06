// attached_assets/god-tier-music.js
const { execFile } = require('node:child_process');

const query = process.argv[2];
if (!query) {
    console.log(JSON.stringify({ error: "No query provided" }));
    process.exit(1);
}

// Helper to run commands safely
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

    // Promise 1: Custom YouTube Script
    const ytPromise = new Promise((resolve, reject) => {
        // Point to the old script sitting in the same folder
        const child = execFile('node', [`./attached_assets/scrape-ytmusik_1793744644906.js`, query, '--stream', '1'], (err, stdout) => {
            if (err) return reject(err);
            try {
                const data = JSON.parse(stdout);
                const url = data.results?.songs?.[0]?.streaming?.stream_url;
                if (url) resolve({ url, source: 'YouTube (Custom)' });
                else reject(new Error('No URL'));
            } catch (e) { reject(e); }
        });
        activeProcesses.push(child);
    });

    // Promise 2: Audiomack & SoundCloud Fallback (Starts after 3s)
    const fallbackPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(async () => {
            console.log(`[Race] YouTube taking >3s. Launching Fallbacks...`);
            
            const audioPromise = new Promise((res, rej) => {
                runCmd('yt-dlp', [`https://audiomack.com/search?q=${query}`, '--dump-json', '--flat-playlist']).then(out => {
                    const results = out.trim().split('\n').map(l => JSON.parse(l));
                    if (results.length === 0) throw new Error("No Audio");
                    runCmd('yt-dlp', [results[0].url, '-f', 'bestaudio', '-g', '--no-playlist']).then(streamOut => {
                        res({ url: streamOut.trim().split('\n')[0], source: 'Audiomack' });
                    }).catch(rej);
                }).catch(rej);
            });

            const soundPromise = new Promise((res, rej) => {
                runCmd('yt-dlp', [`scsearch1:${query}`, '-f', 'bestaudio', '-g', '--no-playlist']).then(out => {
                    res({ url: out.trim().split('\n')[0], source: 'SoundCloud' });
                }).catch(rej);
            });

            Promise.any([audioPromise, soundPromise]).then(resolve).catch(reject);
        }, 3000);

        ytPromise.then((res) => {
            clearTimeout(timer);
            resolve(res);
        }).catch(() => {}); 
    });

    try {
        const winner = await Promise.any([ytPromise, fallbackPromise]);
        activeProcesses.forEach(p => { try { p.kill(); } catch(e) {} });
        
        // Output exactly what the TypeScript backend expects
        console.log(JSON.stringify({
            status: true,
            source: winner.source,
            results: {
                songs: [
                    {
                        title: query,
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
