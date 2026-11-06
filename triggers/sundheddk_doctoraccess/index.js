/** @typedef {{ name: string; }} Doctor */
/** @typedef {{ id: number; name: string; openForPatients: boolean; doctors: Doctor[] }} Practice */
/** @typedef {{ title: string, description: string, url: string, practice: Practice }} Output */

/**
 * Gets the data for a specific doctor on https://www.sundhed.dk/borger/guides/find-behandler/
 */
module.exports = class SundhedDkDoctorAccessTrigger {
  /** @type {{ doctorIds: number[] }} */
  options = { doctorIds: [] };
  /** @type {{ debug: (...args) => void; info: (...args) => void; warn: (...args) => void; error: (...args) => void;  }} */
  log;
  /** @type (input: any) => string */
  createContentDigest;
  /** @type {any} */
  axios;

  constructor({ helpers, options }) {
    this.options = { ...this.options, ...options };
    this.log = helpers.log;
    this.axios = helpers.axios;
    this.createContentDigest = helpers.createContentDigest;
    this.log.debug("Got options", this.options);
  }
  
  getItemKey(/** @type {Output} */ output) {
    return this.createContentDigest(output.practice);
  }

  /** @returns {Output[]} */
  async run() {
    const practices = await this.options.doctorIds.map(id => this.getPracticeInfo(id));
    this.log.debug(`Found doctor practices:`, practices);
    return practices.map(practice => ({
        title: `'${practice.name}' has changed its data`,
        description: `New data is:

\`\`\`
${JSON.stringify(practice, null, 2)}
\`\`\`
`,
        url: `https://www.sundhed.dk/borger/guides/find-behandler/?orgId=${encodeURIComponent(practice.id)}`,
        practice: practice,
    }));
  }

  /** @returns {Practice} */
  async getPracticeInfo(/** @type {number} */ practiceId) {
    const { data } = await this.axios.get(`https://www.sundhed.dk/app/findbehandlerv2/api/v1/findbehandlerv2/klinik/${encodeURIComponent(practiceId)}`);
    this.log.debug(`Loaded practice data for ID ${practiceId} successfully`, data);
    if (data.Identifier !== practiceId) {
        throw new Error(`Looked up practice ${practiceId}, got response for practice ${data.Identifier}`);
    }
    const expectedKeys = {
        "Navn": (v) => typeof v === "string",
        "AabenForTilgang": (v) => typeof v === "boolean",
        "Personale": (v) => Array.isArray(v) && v.every(doctor => doctor instanceof Object && Object.hasOwn(doctor, "Navn") && typeof doctor["Navn"] === "string")
    }
    if (!Object.keys(expectedKeys).every(k => Object.hasOwn(data, k) && expectedKeys[k](data[k]))) {
        throw new Error(`Unexpected data format for practice ${practiceId}. Got: ${JSON.stringify(data)}`);
    }
    return {
        id: data.Identifier,
        name: data.Navn,
        openForPatients: data.AabenForTilgang,
        doctors: data.Personale.map(doctor => { name: doctor.Navn })
    }
  }
};