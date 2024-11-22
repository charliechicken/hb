const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const fs = require('fs');

const app = express();
app.use(express.static('public'));

async function searchGoogle(searchTerm) {
    try {
        const query = encodeURIComponent(`ANSWER: ${searchTerm} filetype:pdf site:iacompetitions.com History-Bowl`);
        const response = await axios.get(`https://www.google.com/search?q=${query}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        const links = new Set();
        
        $('a[href*=".pdf"]').each((_, element) => {
            const link = $(element).attr('href');
            if (link && link.includes('iacompetitions.com') && link.includes('History-Bowl')) {
                const cleanLink = link.startsWith('/url?q=') 
                    ? decodeURIComponent(link.split('/url?q=')[1].split('&')[0])
                    : link;
                links.add(cleanLink);
            }
        });

        return Array.from(links);
    } catch (error) {
        console.error('Error searching Google:', error);
        return [];
    }
}

async function processQuestions(text, searchTerm) {
    let output = '';
    
    try {
        // Regular question pattern
        const questionRegex = /(?:\(\d+\)|BONUS:)(.*?)(?:ANSWER:|A:)(.*?)(?=(?:\(\d+\)|BONUS:|$))/gs;
        
        // Bonus question pattern
        const bonusRegex = /BONUS:.*?(?:ANSWER:|A:)(.*?)(?=(?:\(\d+\)|BONUS:|$))/gs;
        
        let match;
        
        // Process regular questions
        while ((match = questionRegex.exec(text)) !== null) {
            try {
                const question = match[1]
                    .replace(/\s+/g, ' ')
                    .replace(/([a-z])([A-Z])/g, '$1 $2')
                    .replace(/(\w)([.,!?])/g, '$1 $2')
                    .replace(/([.,!?])(\w)/g, '$1 $2')
                    .trim();

                let answer = match[2]
                    .replace(/\s+/g, ' ')
                    .replace(/([a-z])([A-Z])/g, '$1 $2')
                    .replace(/(\w)([.,!?])/g, '$1 $2')
                    .replace(/([.,!?])(\w)/g, '$1 $2')
                    .replace(/\[.*?\]/g, '')
                    .replace(/\{.*?\}/g, '')
                    .trim();

                if (answer.toLowerCase().includes(searchTerm.toLowerCase()) || 
                    question.toLowerCase().includes(searchTerm.toLowerCase())) {
                    output += `Q: ${question}\nA: ${answer}\n\n`;
                }
            } catch (e) {
                console.warn('Error processing question match:', e.message);
                continue; // Skip this match but continue processing
            }
        }
        
        // Process bonus questions separately
        while ((match = bonusRegex.exec(text)) !== null) {
            try {
                const bonusAnswer = match[1]
                    .replace(/\s+/g, ' ')
                    .replace(/([a-z])([A-Z])/g, '$1 $2')
                    .replace(/\[.*?\]/g, '')
                    .replace(/\{.*?\}/g, '')
                    .trim();

                if (bonusAnswer.toLowerCase().includes(searchTerm.toLowerCase())) {
                    const contextStart = Math.max(0, match.index - 200);
                    const context = text.slice(contextStart, match.index + match[0].length)
                        .replace(/\s+/g, ' ')
                        .trim();
                    
                    output += `Q: ${context}\nA: ${bonusAnswer}\n\n`;
                }
            } catch (e) {
                console.warn('Error processing bonus match:', e.message);
                continue; // Skip this match but continue processing
            }
        }
    } catch (e) {
        console.warn('Non-fatal error in processQuestions:', e.message);
        // Continue processing even if there are TT function errors
    }
    
    return output;
}

const htmlTemplate = `
<!DOCTYPE html>
<html>
<head>
    <title>Search Results</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; padding-top: 60px; }
        .search-container { 
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: white;
            padding: 15px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            z-index: 100;
        }
        .question { margin-bottom: 20px; padding: 10px; border: 1px solid #ddd; }
        .source { color: #666; font-size: 0.9em; margin-bottom: 10px; }
        .patterns { 
            margin: 20px 0;
            padding: 15px;
            background: #f5f5f5;
            border-radius: 5px;
        }
    </style>
</head>
<body>
    <div class="search-container">
        <form onsubmit="event.preventDefault(); window.location.href='/search/' + document.getElementById('term').value;">
            <input type="text" id="term" placeholder="Enter search term" style="padding: 5px; width: 200px;">
            <button type="submit">Search</button>
        </form>
    </div>
    <h1>Search Results for: SEARCH_TERM</h1>
    <div class="patterns">
        <h3>Common Patterns Found:</h3>
        PATTERNS_CONTENT
    </div>
    RESULTS_CONTENT
</body>
</html>
`;

async function analyzePatterns(questions) {
    // Split questions into words and clean them
    const words = questions.flatMap(q => {
        const text = `${q.question} ${q.answer}`;
        return text.toLowerCase()
            .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
            .split(/\s+/)
            .filter(word => word.length > 3); // Ignore short words
    });

    // Count word frequencies
    const wordFreq = {};
    words.forEach(word => {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
    });

    // Find significant patterns (words appearing more than twice)
    const patterns = Object.entries(wordFreq)
        .filter(([_, count]) => count > 2)
        .sort(([_, a], [__, b]) => b - a)
        .slice(0, 10)
        .map(([word, count]) => `${word} (${count} times)`);

    return patterns;
}

async function main() {
    const port = 3000;
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });

    app.get('/search/:term', async (req, res) => {
        const searchTerm = req.params.term;
        try {
            const pdfUrls = await searchGoogle(searchTerm);
            console.log(`Found ${pdfUrls.length} PDFs containing "${searchTerm}"`);
            
            let allOutput = '';
            let allQuestions = [];
            
            for (const pdfUrl of pdfUrls) {
                if (!pdfUrl.includes('History-Bowl')) continue;
                
                let retryCount = 0;
                const maxRetries = 3;
                
                while (retryCount < maxRetries) {
                    try {
                        console.log('Processing PDF:', pdfUrl);
                        const pdfResponse = await axios.get(pdfUrl, { 
                            responseType: 'arraybuffer',
                            timeout: 30000
                        });
                        
                        const pdfData = await pdfParse(pdfResponse.data);
                        const output = await processQuestions(pdfData.text, searchTerm);
                        
                        if (output) {
                            allOutput += `<div class="source">From: ${pdfUrl}</div>\n${output}\n`;
                            const matches = [...output.matchAll(/Q: (.*?)\nA: (.*?)\n\n/gs)];
                            allQuestions.push(...matches.map(m => ({
                                question: m[1],
                                answer: m[2]
                            })));
                        }
                        
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        break;
                        
                    } catch (error) {
                        retryCount++;
                        console.error(`Error processing PDF (attempt ${retryCount}/${maxRetries}):`, pdfUrl, error.message);
                        if (retryCount === maxRetries) {
                            console.error(`Failed to process PDF after ${maxRetries} attempts:`, pdfUrl);
                        } else {
                            await new Promise(resolve => setTimeout(resolve, 3000));
                        }
                    }
                }
            }
            
            if (allOutput) {
                const patterns = await analyzePatterns(allQuestions);
                const patternsHtml = patterns.length ? 
                    patterns.join('<br>') : 
                    'No significant patterns found';

                const formattedOutput = allOutput.replace(/Q: (.*?)\nA: (.*?)\n\n/gs, 
                    '<div class="question"><strong>Q:</strong> $1<br><strong>A:</strong> $2</div>\n');
                const html = htmlTemplate
                    .replace('SEARCH_TERM', searchTerm)
                    .replace('PATTERNS_CONTENT', patternsHtml)
                    .replace('RESULTS_CONTENT', formattedOutput);
                res.send(html);
            } else {
                res.send(htmlTemplate
                    .replace('SEARCH_TERM', searchTerm)
                    .replace('PATTERNS_CONTENT', '')
                    .replace('RESULTS_CONTENT', '<p>No matching questions found.</p>'));
            }
            
        } catch (error) {
            console.error('Error:', error);
            res.status(500).send('An error occurred');
        }
    });

    app.get('/', (req, res) => {
        res.send(`
            <html>
                <body>
                    <form action="/search" onsubmit="event.preventDefault(); window.location.href='/search/' + document.getElementById('term').value;">
                        <input type="text" id="term" placeholder="Enter search term">
                        <button type="submit">Search</button>
                    </form>
                </body>
            </html>
        `);
    });
}

main();