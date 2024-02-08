const { load } = require("cheerio");

/** @typedef {{ name: string; description: string; tags: string[]; isSold: boolean; link: string }} Cat */
/** @typedef {Cat & { ageInMonths: number }} AgedCat */

/**
 * Gets the list of cats that are up for adoption at https://inges-kattehjem.dk/adopter-en-kat/
 * Can optionally be filtered by tags (e.g. location or indoor/outdoor status), age in months, or whether they've been adopted (filtered out by default)
 */
module.exports = class IngesKattehjemTrigger {
  /** @type {{ tags: string[], minAgeInMonths: number, maxAgeInMonths: number, onlyAvailable: boolean }} */
  options = { tags: [], minAge: 0, maxAge: Infinity, onlyAvailable: true };
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
  }
  
  getItemKey(/** @type {AgedCat} */ cat) {
    if (!cat) { return this.createContentDigest(cat); }
    if (cat.name && cat.link) {
      return `${cat.name}__${cat.link}`;
    }
    this.log.error("Getting key for cat without name and link", cat);
    return this.createContentDigest({
      name: cat.name,
      description: cat.description,
      tags: cat.tags,
      link: cat.links
    });
  }

  async run() {
    const cats = await this.getCats();
    this.log.debug(`Found cats:`, cats);
    /** @type {AgedCat[]} */
    const agedCats = cats.map(cat => ({
      ...cat,
      ageInMonths: this.guessAgeInMonths(cat)
    }));
    const filteredCats = this.filterCats(agedCats);
    this.log.debug("Post-filtering cats:", filteredCats);
    return filteredCats;
  }

  async getCats() {
    const { data } = await this.axios.get("https://inges-kattehjem.dk/adopter-en-kat/");
    this.log.debug(`Loaded HTML data successfully (length: ${data.length})`);
    const $ = load(data);
    const $cats = $(".cats .cat-item");
    this.log.debug(`Found ${$cats.length} cats`);
    return [...$cats].map((cat,i) => {
      this.log.debug(`Parsing cat ${i}`);
      const $cat = $(cat);
      const name = $cat.find(".cat-name").text();
      const tags = [...$cat.find(".cat-tag")].map(tag => $(tag).text());
      const description = $cat.find(".cat-text").text();
      const isSold = $cat.find(".sold").length > 0;
      const link = $cat.find("a.btn").attr("href");
      /** @type {Cat} */
      const outp = { name, description, tags, isSold, link };
      return outp;
    });
  }

  guessAgeInMonths(/** @type {Cat} */ cat) {
    /** @type {RegExpExecArray | null} */
    let resp = null;
    let age = -1;
    // try to guess the age from the cat name
    if ((resp = /([\d\.,]+)\s*år/.exec(cat.name))) {
      age = (+resp[1]) * 12;
    }
    else if ((resp = /([\d\.,]+)\s*må?n?e?de?r?/.exec(cat.name))) {
      age = (+resp[1]);
    }
    else if ((resp = /([\d\.,]+)\s*uger?/.exec(cat.name))) {
      age = (+resp[1]) / 4;
    }
    // try to guess the age from the description
    else if ((resp = /([\d\.,]+)\s*år/.exec(cat.description))) {
      age = (+resp[1]) * 12;
    }
    else if ((resp = /([\d\.,]+)\s*må?n?e?de?r?/.exec(cat.description))) {
      age = (+resp[1]);
    }
    else if ((resp = /([\d\.,]+)\s*uger?/.exec(cat.description))) {
      age = (+resp[1]) / 4;
    }
    if (age === -1) {
      this.log.warn(`Couldn't guess age of cat ${cat.name}`);
    } else {
      this.log.debug(`Guessed age of cat ${cat.name} to be ${age}`);
    }
    return age;
  }

  filterCats(/** @type {AgedCat[]} */ cats) {
    const { tags, minAgeInMonths, maxAgeInMonths, onlyAvailable } = this.options;
    if (onlyAvailable) {
      cats = cats.filter(cat => !cat.isSold);
    }
    if (typeof minAgeInMonths === "number" && minAgeInMonths >= 0) {
      cats = cats.filter(cat => cat.ageInMonths >= minAgeInMonths);
    }
    if (typeof maxAgeInMonths === "number" && maxAgeInMonths >= 0) {
      cats = cats.filter(cat => cat.ageInMonths <= minAgeInMonths);
    }
    if (tags && tags.length) {
      cats = cats.filter(cat => tags.every(tag => cat.tags.includes(tag)));
    }
    return cats;
  }
};