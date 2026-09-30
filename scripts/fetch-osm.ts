import { getDb, bulkInsert } from "../src/lib/db";
import { getRegion } from "../src/lib/regions";
import { latLngToCell } from "h3-js";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

async function fetchOSM(regionCode: string) {
  const region = getRegion(regionCode);
  const [lat, lng] = region.center;
  // A rough bounding box based on radiusKm (1 deg ~ 111 km)
  const offset = region.radiusKm / 111;
  const bbox = `${lat - offset},${lng - offset},${lat + offset},${lng + offset}`;

  console.log(`Fetching real OpenStreetMap facilities for ${region.name} (${regionCode})...`);
  console.log(`Bounding Box: ${bbox}`);

  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="hospital"](${bbox});
      node["amenity"="clinic"](${bbox});
      node["amenity"="school"](${bbox});
      node["amenity"="toilets"](${bbox});
      node["amenity"="police"](${bbox});
    );
    out body;
  `;

  const url = `${OVERPASS_URL}?data=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": "CivicPulseHackathonApp/1.0", "Accept": "application/json" } });

  if (!res.ok) {
    throw new Error(`Overpass API failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const elements = data.elements || [];
  console.log(`Found ${elements.length} real facilities from OSM!`);

  const db = await getDb();
  
  // Delete old synthetic facilities for this region
  await db.exec(`DELETE FROM facilities WHERE region_code = '${regionCode}' AND source = 'synthetic'`);
  // Or just delete all to be safe
  await db.exec(`DELETE FROM facilities WHERE region_code = '${regionCode}'`);

  const rows = elements.map((node: any) => {
    const type = node.tags.amenity || "unknown";
    const name = node.tags.name || `Unnamed ${type}`;
    const h3 = latLngToCell(node.lat, node.lon, region.h3Res);
    
    // Map OSM amenity to our internal categories (health, education, sanitation, security)
    let category = "other";
    if (type === "hospital" || type === "clinic") category = "health";
    if (type === "school") category = "education";
    if (type === "toilets") category = "sanitation";
    if (type === "police") category = "security";

    return [
      regionCode,
      category,
      type,
      name,
      node.lat,
      node.lon,
      h3,
      "OpenStreetMap",
    ];
  });

  if (rows.length > 0) {
    await bulkInsert(db, "facilities", 
      ["region_code", "category", "type", "name", "lat", "lng", "h3_cell", "source"], 
      rows
    );
    console.log(`✅ Successfully saved ${rows.length} real facilities to the database for ${region.name}!`);
  } else {
    console.log("No facilities found in this bounding box.");
  }
}

const regionCode = process.argv[2] || "IN-DL";
fetchOSM(regionCode)
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
