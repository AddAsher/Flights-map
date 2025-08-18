const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const fs = require('fs'); // Node.js File System module

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const config = {
    user: 'Seico',
    password: '0216',
    server: '44.236.194.216',
    database: 'Aerosucre',
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
};

// --- START: Caching Logic ---
const CACHE_FILE_PATH = './geocode-cache.json';
let geocodeCache = {};

// Load the cache from the file if it exists when the server starts
try {
    if (fs.existsSync(CACHE_FILE_PATH)) {
        const data = fs.readFileSync(CACHE_FILE_PATH);
        geocodeCache = JSON.parse(data);
        console.log(`Loaded ${Object.keys(geocodeCache).length} coordinates from cache file.`);
    }
} catch (err) {
    console.error("Error loading cache file:", err);
}

// Function to save the cache to a file
function saveCache() {
    console.log('\nSaving coordinates cache to file...');
    fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(geocodeCache, null, 2));
    console.log('Cache saved. Exiting.');
}
// --- END: Caching Logic ---

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

app.get('/api/airports', async (req, res) => {
    try {
        await sql.connect(config);
        const result = await sql.query`SELECT Codigociudad, Descripcion, Codpais FROM Ciudades`;
        
        const airportCoords = {};
        let needsSave = false; // Flag to check if we need to save the cache file

        for (const city of result.recordset) {
            const cityCode = city.Codigociudad;

            if (geocodeCache[cityCode]) {
                airportCoords[cityCode] = geocodeCache[cityCode];
                // console.log(cityCode, "Found")
            } else {
                needsSave = true; // We found a new city, so we'll need to save the cache
                const cityName = city.Descripcion.split(',')[0].trim();
                console.log(`Geocoding (live): ${city.Descripcion} to ${cityName} with code ${city.Codigociudad} and Country ${city.Codpais}`);
                // This will split "EXTON, PENNSYLVANIA" into ["EXTON", " PENNSYLVANIA"]
                // and take the first part, "EXTON". The .trim() removes any extra spaces.
                var params = new URLSearchParams({
                    city: cityName,
                    country: city.Codpais,
                    format: 'json',
                    limit: 1
                });

                var response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
                    headers: { 'User-Agent': 'FlightMapApp/1.0 (your-email@example.com)' }
                });
                if(response.headers.get('Content-Length')==='2'){
                    console.log("inside");
                    await delay(1000); 
                    var params = new URLSearchParams({
                    city: cityName,
                    format: 'json',
                    limit: 1
                    });
                    response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
                    headers: { 'User-Agent': 'FlightMapApp/1.0 (your-email@example.com)' }
                    });
                }


                const data = await response.json();

                if (data && data.length > 0) {
                    const location = {
                        name: city.Descripcion,
                        coords: [parseFloat(data[0].lat), parseFloat(data[0].lon)]
                    };
                    airportCoords[cityCode] = location;
                    geocodeCache[cityCode] = location; 
                }
                else{
                    console.log("Didn't find location for " +city.Codigociudad);
                }
                await delay(1000); 
            }
        }
        
        // If we geocoded any new cities, save the updated cache to the file
        if (needsSave) {
            saveCache();
        }
        
        res.json(airportCoords);

    } catch (err) {
        console.error('Database or API error:', err);
        res.status(500).json({ error: 'Failed to retrieve airport data' });
    }
});

// The /api/routes endpoint remains the same...
app.get('/api/routes', async (req, res) => {
    try {
        await sql.connect(config);
        console.log("in routes");
        const result = await sql.query`
            SELECT 
                Origen, 
                Destino, 
                COUNT(*) as flights,
                SUM(Tiempovuelo) as totalTime,
                COUNT(DISTINCT Codigovuelo) as uniqueFlights
            FROM Bvaeronave 
            WHERE Fechavuelo >= DATEADD(year, -1, GETDATE())
            GROUP BY Origen, Destino
        `;
        res.json(result.recordset);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Database connection failed' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// Save the cache when you stop the server gracefully (with Ctrl + C)
process.on('SIGINT', () => {
    saveCache();
    process.exit();
});