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
const GEOCODE_CACHE_FILE = './geocode-cache.json';
const ROUTES_CACHE_FILE = './routes-cache.json';
let geocodeCache = {};
let routesCache = null;
let routesCacheTimestamp = null;

// Load the geocode cache from the file if it exists when the server starts
try {
    if (fs.existsSync(GEOCODE_CACHE_FILE)) {
        const data = fs.readFileSync(GEOCODE_CACHE_FILE);
        geocodeCache = JSON.parse(data);
        console.log(`Loaded ${Object.keys(geocodeCache).length} coordinates from cache file.`);
    }
} catch (err) {
    console.error("Error loading geocode cache file:", err);
}

// Load the routes cache from the file if it exists when the server starts
try {
    if (fs.existsSync(ROUTES_CACHE_FILE)) {
        const data = fs.readFileSync(ROUTES_CACHE_FILE);
        const cacheData = JSON.parse(data);
        routesCache = cacheData.routes;
        routesCacheTimestamp = new Date(cacheData.timestamp);
        console.log(`Loaded ${routesCache.length} routes from cache file. Last updated: ${routesCacheTimestamp}`);
    }
} catch (err) {
    console.error("Error loading routes cache file:", err);
}

// Function to save the geocode cache to a file
function saveGeocodeCache() {
    console.log('\nSaving coordinates cache to file...');
    fs.writeFileSync(GEOCODE_CACHE_FILE, JSON.stringify(geocodeCache, null, 2));
    console.log('Geocode cache saved.');
}

// Function to save the routes cache to a file
function saveRoutesCache(routes) {
    console.log('\nSaving routes cache to file...');
    const cacheData = {
        timestamp: new Date().toISOString(),
        routes: routes
    };
    fs.writeFileSync(ROUTES_CACHE_FILE, JSON.stringify(cacheData, null, 2));
    routesCache = routes;
    routesCacheTimestamp = new Date();
    console.log('Routes cache saved.');
}

// Check if routes cache is still valid (24 hours)
function isRoutesCacheValid() {
    if (!routesCacheTimestamp) return false;
    const now = new Date();
    const hoursSinceUpdate = (now - routesCacheTimestamp) / (1000 * 60 * 60);
    return hoursSinceUpdate < 24; // Cache valid for 24 hours
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
            saveGeocodeCache();
        }
        
        res.json(airportCoords);

    } catch (err) {
        console.error('Database or API error:', err);
        res.status(500).json({ error: 'Failed to retrieve airport data' });
    }
});

// Updated /api/routes endpoint with caching
app.get('/api/routes', async (req, res) => {
    try {
        // Check if we have valid cached routes
        if (routesCache && isRoutesCacheValid()) {
            console.log("Serving routes from cache");
            res.json(routesCache);
            return;
        }

        // Cache is invalid or doesn't exist, fetch from database
        console.log("Fetching routes from database...");
        await sql.connect(config);
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
        
        // Save to cache
        saveRoutesCache(result.recordset);
        
        res.json(result.recordset);
    } catch (err) {
        console.error('Database error:', err);
        
        // If database fails but we have cached data, serve it
        if (routesCache) {
            console.log("Database failed, serving stale cache");
            res.json(routesCache);
        } else {
            res.status(500).json({ error: 'Database connection failed and no cache available' });
        }
    }
});

// New endpoint to force refresh routes cache
app.get('/api/routes/refresh', async (req, res) => {
    try {
        console.log("Force refreshing routes cache...");
        await sql.connect(config);
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
        
        saveRoutesCache(result.recordset);
        res.json({ message: 'Routes cache refreshed successfully', routes: result.recordset.length });
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Failed to refresh routes cache' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Routes cache status: ${isRoutesCacheValid() ? 'Valid' : 'Invalid/Missing'}`);
});

// Save the cache when you stop the server gracefully (with Ctrl + C)
process.on('SIGINT', () => {
    if (Object.keys(geocodeCache).length > 0) {
        saveGeocodeCache();
    }
    console.log('Cache saved. Exiting.');
    process.exit();
});