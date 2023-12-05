const puppeteer = require('puppeteer');
const fs = require("fs")
const path = require("path");
const Queue = require("queue-promise")
const toml = require("toml")

const localhost = "http://localhost:1313/"
const config = toml.parse(fs.readFileSync("./hugo.toml", 'utf-8'))
const host = config.baseURL

const jsonPath = __dirname + path.sep + "prebuild" + path.sep + "data" + path.sep + "bachelor.json"
const basePath = "bachelor"
const bachelor = require(jsonPath)

/**
 * Replaces known diacritics in a string by their non-diacritic equivalent
 * @param str
 * @returns {string}
 */
function sanitizeString(str) {
    return str.toLowerCase()
                .replaceAll(/[À-Åà-å]/g, "a")
                .replaceAll(/[È-Ëè-ë]/g, "e")
                .replaceAll(/[Ì-Ïì-ï]/g, "i")
                .replaceAll(/[Ò-Öò-ö]/g, "o")
                .replaceAll(/[Ù-Üù-ü]/g, "u")
                .replaceAll(/[Çç]/g, "c")
                .replaceAll(/:/g, "")
                .replaceAll(/[ \/]/g, "-")
}

/**
 * Generates 3 arrays containing the relative path to every page of the website. The first array contains the path to
 * every formation mode page, the second array contains the path to every module description page and the third array
 * contains the path to every unit sheet page.
 * Note that the Hugo site is generated from the bachelor.json file, so the paths are generated from the same file.
 * @returns {*[][]}
 */
function getPagesPath() {
    let modes = []
    let modules = []
    let unites = []
    for (let domain of bachelor.domaines) {
        const domainPath = basePath + "/" + sanitizeString(domain.domaine_nom)
        for (let academicEntity of domain.entites_academiques) {
            const academicEntityPath = domainPath + "/" + sanitizeString(academicEntity.entite_academique_abreviation)
            for (let option of academicEntity.filieres) {
                const optionPath = academicEntityPath + "/" + sanitizeString(option.filiere_abreviation)
                for (let formation of option.formations) {
                    const formationPath = optionPath + "/" + sanitizeString(formation.formation_abreviation)
                    for (let mode of formation.modes_formation) {
                        const modePath = formationPath + "/" + sanitizeString(mode.mode_formation_abreviation)
                        modes.push(modePath)
                        for (let module of mode.modules) {
                            const modulePath = modePath + "/" + sanitizeString(module.module_code)
                            modules.push(modulePath)
                            if ('unites' in module && module.unites != null) {
                                for (let unite of module.unites) {
                                    const unitePath = modulePath + "/" + sanitizeString(unite.unite_abreviation)
                                    unites.push(unitePath)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return [modes, modules, unites]
}

/**
 * Pads a number to 2 digits
 * @param {Number} num - Number to be pad
 * @returns {String} padded number
 */
function padTo2Digits(num) {
    return num.toString().padStart(2, '0');
}

/**
 * Convert milliseconds in human friendly time range
 * @param {Number} milliseconds - Number of millisecond to process
 * @returns {string} formatted time range string
 */
function msToHMS(milliseconds) {
    let seconds = Math.floor(milliseconds / 1000);
    let minutes = Math.floor(seconds / 60);
    let hours = Math.floor(minutes / 60);

    seconds = seconds % 60;
    minutes = minutes % 60;

    hours = hours % 24;

    return `${padTo2Digits(hours)}:${padTo2Digits(minutes)}:${padTo2Digits(
        seconds,
    )}`;
}

/* PDF parallel Scrapping settings */
const maxParallelBookletGeneration = 4
const maxParallelDescriptionGeneration = 8
const maxParallelSheetGeneration = 10

/* Delays to wait fo asynchronous tasks (Img writing, saving documents, opening/closing browser contexts) */
const saveTime = 300
const devServerDelay = 4000

/**
 * PDFGenerator class to handle PDF generation from a list of relative paths, using puppeteer, Queue-promise and jsPDF.
 */
class PDFGenerator {
    constructor(browser, viewport) {
        this.browser = browser
        this.viewport = viewport
    }

    /**
     * Runs the PDF generation from a list of relative paths. The generation is done in 3 steps:
     * 1. Generation of formation booklets
     * 2. Generation of module descriptions
     * 3. Generation of unit sheets
     * Each step runs parallel tasks, with a maximum number of parallel generation specified by the user.
     * @param booklets
     * @param modules
     * @param units
     * @param maxParallelBookletGeneration
     * @param maxParallelDescriptionGeneration
     * @param maxParallelSheetGeneration
     * @returns {Promise<unknown>}
     */
    run(booklets, modules, units, maxParallelBookletGeneration, maxParallelDescriptionGeneration, maxParallelSheetGeneration) {
        return new Promise(resolve => {
            const start = performance.now()
            const queueBooklets = new Queue({
                concurrent: maxParallelBookletGeneration,
                interval: 0
            })
            queueBooklets.enqueue(booklets.map(x => {
                return async () => {
                    await this.generatePDFFromRelativePath(x, "mode")
                }
            }))
            queueBooklets.on("reject", (err) => {
                console.info(err)
            })
            queueBooklets.on("end", () => {
                const moduleStart = performance.now()
                console.info("Generated formation booklets in ", msToHMS(moduleStart - start))
                const queueDescriptions = new Queue({
                    concurrent: maxParallelDescriptionGeneration,
                    interval: 0
                })
                queueDescriptions.enqueue(modules.map(x => {
                    return async () => {
                        await this.generatePDFFromRelativePath(x, "module")
                    }
                }))
                queueDescriptions.on("reject", (err) => {
                    console.info(err)
                })
                queueDescriptions.on("end", () => {
                    const unitStart = performance.now()
                    console.info("Generated module descriptions in ", msToHMS(unitStart - moduleStart))
                    const queueSheets = new Queue({
                        concurrent: maxParallelSheetGeneration,
                        interval: 0
                    })
                    queueSheets.enqueue(units.map(x => {
                        return async () => {
                            await this.generatePDFFromRelativePath(x, "unite")
                        }
                    }))
                    queueSheets.on("reject", (err) => {
                        console.info(err)
                    })
                    queueSheets.on("end", () => {
                        const end = performance.now()
                        console.info("Generated unit sheets in ", msToHMS(end - unitStart))
                        console.info("Generated PDF files in ", msToHMS(end - start))
                        resolve()
                    })
                    queueSheets.start()
                    console.info("Generating unit sheets...")
                })
                queueDescriptions.start()
                console.info("Generating module descriptions...")
            })
            queueBooklets.start()
            console.info("Generating booklets...")
        })
    }

    /**
     * Opens a new browser context. Each PDF generation is done in a new context to avoid conflicts between them.
     * @returns {Promise<*>}
     */
    async openNewContext() {
        return await this.browser.createIncognitoBrowserContext()
    }

    /**
     * Closes a browser context
     * @param context
     * @returns {Promise<*>}
     */
    async closeContext(context) {
        return await context.close()
    }

    /**
     * Opens a new page in a new context and loads the page at the specified relative path.
     * @param relativePath
     * @returns {Promise<*[]>}
     */
    async openNewPage(relativePath) {
        const context = await this.openNewContext()
        const page = await context.newPage()
        // Uncomment to debug with logs from puppeteer page context
        // page.on('console', msg => console.log(relativePath + ': ', msg.text()))
        await page.goto(localhost + relativePath)
        await page.setViewport(this.viewport)
        return [page, context]
    }

    /**
     * Sets the download folder for the specified page.
     * @param page
     * @param folder
     * @returns {Promise<void>}
     */
    async setDownloadFolder(page, folder) {
        const client = await page.target().createCDPSession()
        if (!fs.existsSync(path.join(__dirname, folder))) fs.mkdirSync(folder, {recursive: true})
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: folder,
        })
    }

    /**
     * Loads the page content from the DOM. This is used to be sure that the page is fully loaded before generating the
     * PDF.
     * @param page
     * @returns {Promise<void>}
     */
    async loadPage(page) {
        const dom = await page.$eval('html', element => {
            return element.innerHTML
        })
        await page.setContent(dom)
    }

    /**
     * Generates a PDF file from the specified page and saves it to the specified filename.
     * @param page
     * @param filename
     * @param type
     * @returns {Promise<void>}
     */
    async generatePDF(page, filename, type) {
        await page.evaluate(async ([filename, type, host, localhost]) => {

            const {jsPDF} = window.jspdf

            /* PDF generation settings */
            const imgWriteDelay = 5 // Time to wait in ms before assuming image is written in PDF

            /* PDF layout */
            const marginTop = 60
            const marginBot = 30
            const marginLeft = 20
            const marginRight = marginLeft
            const margins = [marginTop, marginRight, marginBot, marginLeft]
            const options = {
                orientation: "p",
                unit: "px",
                format: "a4",
                margin: margins,
                compress: true,
                precision: 10
            }

            /* Image sources */
            const hesImgPath = "/images/logo_hesso_bw.svg"
            const heigImgPath = "/images/logo-heig-21-fr.svg"

            /* Footer */
            const infos = "T +41 (0)24 557 63 30\ninfo@heig-vd.ch"
            const footerFontSize = 7

            /* Header */
            const imgYmargin = 10
            const hesImgLoaded = loadSVG(hesImgPath, 6)
            const heigImgLoaded = loadSVG(heigImgPath, 6)

            /* Unvalidated modules page */
            const sectionBoxMargin = 2
            const sectionBoxColor = "#939090"
            const sectionFontSize = 7
            const modulesNameFontSize = 5
            const sectionSpacingY = 10

            /* Hyperlinks injection */
            const linkShiftX = 0.5
            let linkShiftY = 0.75;
            const pageAnchorShiftX = 2
            const pageAnchorShiftY = - 1

            /* Other settings */
            const interLine = 3

            /* ------------------------- Utils ------------------------- */

            /**
             * Loads an SVG file and returns a promise resolving with the image data, width and height
             * @param svgPath - Path to the SVG file
             * @param dimensionScale - Scale to apply to the SVG dimensions to maintain final quality
             * @returns {Promise<unknown>} A promise resolving with the image data, width and height
             */
            function loadSVG(svgPath, dimensionScale = 1) {
                return new Promise(resolve => {
                    $.get(svgPath, function(data) {
                        const svg = new XMLSerializer().serializeToString(data.documentElement)
                        const img = document.createElement('img');
                        img.src = 'data:image/svg+xml;base64,' + window.btoa(svg);
                        img.onload = function () {
                            const canvas = document.createElement('canvas');
                            const width = img.width * dimensionScale
                            const height = img.height * dimensionScale
                            canvas.width = width;
                            canvas.height = height;
                            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                            const imgData = canvas.toDataURL('image/png', 1.0);
                            resolve([imgData, img.width, img.height])
                        }
                    });
                })
            }

            /**
             * Generate a list of objects containing the relative position within content,
             * hyperlink and if the link is a module header of every links present in the content.
             * This function is used to render hyperlinks and PDF anchors in the final documents.
             * @param {Element} content - The Elements containing the contents wanted in the PDF
             * @returns {Object[]} List of objects describing the links
             */
            function getLinksRelativeCoords(content) {
                const links = content.querySelectorAll(".pdf-link")
                const contentBRect = content.getBoundingClientRect()
                let linksCoords = []
                for (let i = 0; i < links.length; i++) {
                    const link = links[i]
                    const linkBRect = link.getBoundingClientRect()
                    const url = link.href.replace(localhost, host + "/")
                    linksCoords.push({
                        x: linkBRect.left - contentBRect.left,
                        yTop: linkBRect.top - contentBRect.top,
                        yBot: linkBRect.bottom - contentBRect.top,
                        w: linkBRect.right - linkBRect.left,
                        h: linkBRect.bottom - linkBRect.top,
                        text: link.innerHTML,
                        url: url,
                        moduleHeader: (link.className).includes("module-header")
                    })
                }
                return linksCoords
            }

            /* ------------------------- PDF sections population ------------------------- */
            /**
             * A class to split HTML content into pages that fit in a PDF document.
             */
            class ContentSplitter {
                constructor(contentRoot, width, height, splittableContent) {
                    this.contentRoot = contentRoot
                    this.width = width
                    this.height = height
                    this.scale = width / contentRoot.offsetWidth
                    this.splitContentDiv = this.contentRoot.parentNode.cloneNode(false)
                    this.addContentToBody()
                    this.currentDiv = this.splitContentDiv
                    this.splittableContent = splittableContent
                }

                set contentRoot(contentRoot) {
                    this._contentRoot = contentRoot
                }

                get contentRoot() {
                    return this._contentRoot
                }

                set currentDiv(currentDiv) {
                    this._currentDiv = currentDiv
                }

                get currentDiv() {
                    return this._currentDiv
                }

                set splitContentDiv(splitContentDiv) {
                    this._splitContentDiv = splitContentDiv
                }

                get splitContentDiv() {
                    return this._splitContentDiv
                }

                get nPages() {
                    return this.splitContentDiv.children.length
                }

                get currentHeight() {
                    return this.splitContentDiv.lastChild === null ? 0 : this.splitContentDiv.lastChild.offsetHeight * this.scale
                }

                addContentToBody() {
                    const body = document.body
                    let currentNode = this.contentRoot.parentNode
                    let currentCloneNode = this.splitContentDiv
                    while (currentNode.parentNode !== body) {
                        const parent = currentNode.parentNode
                        const cloneParent = parent.cloneNode(false)
                        cloneParent.appendChild(currentCloneNode)
                        currentCloneNode = cloneParent
                        currentNode = parent
                    }
                    body.appendChild(currentCloneNode)
                }

                fitsInPage() {
                    return this.currentHeight <= this.height
                }
                roundBottomBorders(children) {
                    if (children.length === 0) return
                    let lastChild = children[children.length - 1]
                    if (lastChild.classList === undefined) return
                    lastChild.classList.remove("border-bottom-0")
                    lastChild.classList.remove("rounded-bottom-0")
                    lastChild.classList.add("border-bottom-1")
                    lastChild.classList.add("rounded-bottom-1")
                    this.roundBottomBorders(Array.prototype.slice.call(lastChild.children))
                }

                roundTopBorders(children) {
                    if (children.length === 0) return
                    let firstChild = children[0]
                    if (firstChild.classList === undefined) return
                    firstChild.classList.remove("border-top-0")
                    firstChild.classList.remove("rounded-top-0")
                    firstChild.classList.add("border-top-1")
                    firstChild.classList.add("rounded-top-1")
                    this.roundTopBorders(Array.prototype.slice.call(firstChild.children))
                }

                splitContent() {
                    this._splitContent(this.contentRoot)


                    for (let child of Array.prototype.slice.call(this.splitContentDiv.children)) {
                        child.classList.add("border-1")
                        child.classList.add("rounded-1")
                        this.roundTopBorders(Array.prototype.slice.call(child.children))
                        this.roundBottomBorders(Array.prototype.slice.call(child.children))
                    }
                }

                /**
                 * Splits the content into pages that fit in the PDF document. The content is split iterating on the
                 * children of the content root. If a child is a node of type specified in the splittableContent and
                 * will not fit in the current page, the function is called recursively on this node. For each
                 * encountered element, the function tries to add it to the current page. If the content does not fit in
                 * the page, the function tries to split the content. If the content cannot be split, a new page is
                 * added to the document and the content is added to this new page.
                 * No PDF document is involved yet as this method will work with divs as the document pages
                 * and a scale factor calculated from the width of the content root and the width of the PDF document.
                 * @param content
                 * @private
                 */
                _splitContent(content) {
                    /* Ignores unwanted content */
                    if (content.getAttribute("data-html2canvas-ignore") !== null) return
                    this.currentDiv.appendChild(content.cloneNode(true))
                    if (this.fitsInPage()) { // Adding node and its children
                        console.info("Content fits in page")
                        console.info("Current height: " + this.currentHeight + "/" + this.height)
                    } else {
                        console.info("Content has to be split")
                        this.currentDiv.removeChild(this.currentDiv.lastChild) // Removing node added to test height
                        const children = Array.prototype.slice.call(content.children)
                        const childrenElements = children.filter(child => this.splittableContent.includes(child.nodeName))
                        function getChildrenDegree(children) {
                            if (children.length === 0) return 1
                            let degree = children.length
                            for (let child of children) {
                                degree *= getChildrenDegree(Array.prototype.slice.call(child.children))
                            }
                            return degree
                        }
                        if (childrenElements.length === children.length && getChildrenDegree(children) > 1) { // Node
                            console.info("Content can be split")
                            this.currentDiv.appendChild(content.cloneNode(false))
                            this.currentDiv = this.currentDiv.lastChild
                            for (let i = 0; i < childrenElements.length; i++) {
                                this._splitContent(childrenElements[i])
                            }
                            this.currentDiv = this.currentDiv.parentNode
                        } else {
                            console.info("Content cannot be split, adding new page")
                            /* Cleans empty divs added to try content split */
                            let curr = this.currentDiv
                            while (curr.firstChild === null) {
                                console.info("Removing empty div")
                                const parent = curr.parentNode
                                parent.removeChild(curr)
                                curr = parent
                            }
                            /* Reconstructs tree from content Root */
                            this.currentDiv = content.parentNode.cloneNode(false)
                            this.currentDiv.appendChild(content.cloneNode(true))
                            let currentNode = content.parentNode
                            let currentCloneNode = this.currentDiv
                            while (currentNode !== this.contentRoot) {
                                const parent = currentNode.parentNode
                                const cloneParent = parent.cloneNode(false)
                                cloneParent.appendChild(currentCloneNode)
                                currentCloneNode = cloneParent
                                currentNode = parent
                            }
                            this.splitContentDiv.appendChild(currentCloneNode)
                            if (!this.fitsInPage()) {
                                console.warn("Content cannot be split and is too big for one page")
                                this.currentDiv.removeChild(this.currentDiv.lastChild)
                            }
                        }
                    }
                }
            }

            /**
             * A class to generate a PDF document from HTML content.
             */
            class PDFGenerator extends ContentSplitter {
                constructor(content, doc, splittableContent) {
                    super(content, doc.internal.pageSize.getWidth() - (marginLeft + marginRight), doc.internal.pageSize.getHeight() - (marginTop + marginBot), splittableContent);
                    this.doc = doc;
                }

                /* ------------------------- Header and footer ------------------------- */
                /**
                 * Adds the page number to every page footer
                 */
                addPageNumberToDoc() {
                    return new Promise(resolve => {
                        const nPages = this.doc.internal.getNumberOfPages()
                        for (let i = 1; i <= nPages; i++) {
                            this.doc.setPage(i)
                            const text = `${i} / ${nPages}`
                            const textWidth = this.doc.getTextWidth(text)
                            const x = (this.doc.internal.pageSize.getWidth() - marginLeft - marginRight) / 2 - textWidth / 2
                            this.doc.setFont(undefined, "normal").text(`${i} / ${nPages}`, x, this.doc.internal.pageSize.getHeight() - marginBot / 2, {baseline: "bottom"})
                        }
                        resolve("Added page number to PDF")
                    })
                }

                /**
                 * Adds footer the document specified page.
                 * @param {Number} pageNumber - The number of the page where the footer should be added
                 */
                pageFooter(pageNumber) {
                    const footerY = this.doc.internal.pageSize.getHeight() - marginBot / 2
                    let footerX = marginLeft
                    this.doc.setPage(pageNumber).setFont(undefined, "normal").setFontSize(footerFontSize).text(infos, footerX, footerY, {baseline: "bottom"})
                    return new Promise(resolve => {
                        hesImgLoaded.then(([imgDataURL, width, height]) => {
                            const imgHeight = marginBot - 2 * imgYmargin
                            const imgWidth = width * imgHeight / height
                            footerX = this.doc.internal.pageSize.getWidth() - marginRight - imgWidth
                            this.doc.setPage(pageNumber).addImage(imgDataURL, "PNG", footerX, footerY - imgHeight / 2, imgWidth, imgHeight, undefined, 'FAST')
                            setTimeout(() => {
                                resolve("Added footer to PDF on page " + pageNumber)
                            }, imgWriteDelay)
                        })
                    })
                }

                /**
                 * Adds header the document specified page.
                 * @param {Number} pageNumber - The number of the page where the header should be added
                 * @param {string} headerTitle - The title of the header
                 */
                pageHeader(pageNumber, headerTitle) {
                    const headerY = imgYmargin
                    let headerX = marginLeft
                    return new Promise(resolve => {
                            heigImgLoaded.then(([imgDataURL, width, height]) => {
                                const imgHeight = marginTop - 2 * imgYmargin
                                const imgWidth = width * imgHeight / height
                                this.doc.setPage(pageNumber).addImage(imgDataURL, "PNG", headerX, headerY, imgWidth, imgHeight, undefined, 'FAST')
                                headerX += this.doc.internal.pageSize.getWidth() - marginLeft - 2 * marginRight - this.doc.getTextWidth(headerTitle)
                                this.doc.setPage(pageNumber).setFont(undefined, "bold").text(headerTitle, headerX, headerY, {baseline: "top"})
                                setTimeout(() => {
                                    resolve("Added header to PDF on page " + pageNumber)
                                }, imgWriteDelay)
                            })
                        }
                    )
                }

                /**
                 * Adds header and footer the document specified page.
                 * @param {Number} pageNumber - The number of the page where the header and footer should be added
                 * @param {string} headerTitle - The title of the header
                 */
                pageHeaderFooter(pageNumber, headerTitle) {
                    const tasks = [this.pageFooter(pageNumber), this.pageHeader(pageNumber, headerTitle)]
                    return Promise.all(tasks)
                }

                /**
                 * Adds header and footer the document specified range of pages.
                 * @param {*} startPage - First page on which header and footer should be added
                 * @param {*} endPage - Last page on which header and footer should be added
                 * @param {*} headerTitle - The title of the header
                 */
                addHeaderFooterToDoc(startPage, endPage, headerTitle) {
                    let tasks = []
                    for (let i = startPage; i <= endPage; i++) {
                        tasks.push(this.pageHeaderFooter(i, headerTitle))
                    }
                    return Promise.all(tasks)
                }

                /**
                 * Adds hyperlinks to the document specified page. As jsPDF does not support HTML links, the function
                 * uses the getLinksRelativeCoords function to get the relative position of every link in the content
                 * and adds a link to the PDF document at the same position.
                 * @param content
                 * @param pageNumber
                 * @returns {Promise<unknown>}
                 */
                addLinksToContent(content, pageNumber) {
                    return new Promise(resolve => {
                        if (content) {
                            const links = getLinksRelativeCoords(content)
                            this.doc.setPage(pageNumber)
                            for (let link of links) {
                                const linkX = marginLeft + link.x * this.scale
                                const linkY = marginTop + link.yTop * this.scale
                                this.doc.link(linkX + linkShiftX, linkY + linkShiftY, link.w * this.scale, link.h * this.scale, {url: link.url})
                            }
                        }
                        resolve()
                    })
                }

                addLinksToDoc(pageNumber) {
                    const tasks = []
                    const nPages = this.doc.internal.getNumberOfPages()
                    for (let i = pageNumber; i <= nPages; i++) {
                        this.doc.setPage(i)
                        const content = Array.prototype.slice.call(this.splitContentDiv.children).at(i - 1)
                        tasks.push(this.addLinksToContent(content, i))
                    }
                    return Promise.all(tasks)
                }

                /**
                 * Clears overflow pages from the document. jsPDF seems to add blank pages overflow pages when calling
                 * the html function (Maybe a scaling issue ?). This function removes these pages.
                 * @param wantedPages - The number of pages wanted in the document
                 */
                clearOverflowingPages(wantedPages) {
                    const nPages = this.doc.internal.getNumberOfPages()
                    if (nPages > wantedPages) {
                        for (let i = nPages; i > wantedPages; i--) {
                            this.doc.deletePage(i)
                        }
                    }
                }

                /**
                 * Adds pages to the document. The function adds a page to the document for each page in the pages
                 * array, considering that each element of the array fits in one page.
                 * @param pages
                 * @param pageNumber
                 * @returns {Promise<unknown>}
                 */
                addPages(pages, pageNumber) {
                    const pdfGenerator = this
                    function _addPages(pages, pageNumber, resolve) {
                        if (pages.length < 1) {
                            resolve()
                            return
                        }
                        const page = pages.at(0)
                        pdfGenerator.doc.addPage()
                        pdfGenerator.doc.html(page, {
                            html2canvas: {
                                allowTaint: true,
                                useCORS: true,
                                logging: false,
                                scale: pdfGenerator.scale,
                                removeContainer: true
                            },
                            y: (pageNumber - 1) * pdfGenerator.height,
                            margin: margins,
                            callback: function (_) {
                                pdfGenerator.clearOverflowingPages(pageNumber)
                                _addPages(pages.slice(1), ++pageNumber, resolve)
                            }
                        })
                    }
                    return new Promise(resolve => {
                        _addPages(pages, pageNumber, resolve)
                    })
                }

                /**
                 * Adds the content to the document from the specified start page. The function splits the content into
                 * pages that fit in the PDF document and adds these pages to the document.
                 * Note that you can provide a contentStart and contentEnd to specify the range of pages to add to the
                 * document.
                 * @param pageNumber
                 * @param contentStart
                 * @param contentEnd
                 * @returns {Promise<void>}
                 */
                async populatePDF(pageNumber, contentStart = 0, contentEnd = -1) {
                    if (contentEnd === -1) contentEnd = this.nPages
                    if (contentStart > contentEnd) throw new Error("Content start page is greater than content end page")
                    await this.addPages(Array.prototype.slice.call(this.splitContentDiv.children, contentStart, contentEnd), pageNumber)
                }

                /**
                 * Saves the document with the specified filename. This method calls the corresponding jsPDF method, so
                 * keep in mind that if you provide a path as filename, the file will be saved in the download folder
                 * but with the formatted path as filename.
                 * @param filename
                 * @returns {Promise<void>}
                 */
                async savePDF(filename) {
                    console.info("Saving PDF")
                    await this.doc.save(filename, {returnPromise: true})
                    console.info("Saved PDF")
                }
            }

            /**
             * A class to generate a PDF document from a unit sheet page.
             */
            class unitPDFGenerator extends PDFGenerator {
                constructor(content, doc, splittableContent) {
                    super(content, doc, splittableContent);
                }

                async generateFile() {
                    this.splitContent()
                    await this.populatePDF(1)
                    await this.addHeaderFooterToDoc(1, this.doc.internal.getNumberOfPages(), "Fiche d'unité")
                    await this.addLinksToDoc(1)
                    await this.addPageNumberToDoc()
                }
            }

            /**
             * A class to generate a PDF document from a module description page.
             */
            class modulePDFGenerator extends PDFGenerator {
                constructor(content, doc, splittableContent) {
                    super(content, doc, splittableContent);
                }

                async generateFile() {
                    this.splitContent()
                    await this.populatePDF(1)
                    await this.addHeaderFooterToDoc(1, this.doc.internal.getNumberOfPages(), "Descriptif de module")
                    await this.addLinksToDoc(1)
                    await this.addPageNumberToDoc()
                }
            }

            /**
             * A class to generate a PDF document from a formation booklet page.
             */
            class formationBookletGenerator extends PDFGenerator {
                constructor(content, doc, splittableContent) {
                    super(content, doc, splittableContent);
                    this.nPagesPlanning = 0
                    this.modulesPage = []
                    this.unvalidatedModules = []
                    this.remoteContentDiv = this.contentRoot.parentNode.cloneNode(false)
                    this.addRemoteContentToBody()
                }

                addRemoteContentToBody() {
                    const body = document.body
                    let currentNode = this.contentRoot.parentNode
                    let currentCloneNode = this.remoteContentDiv
                    while (currentNode.parentNode !== body) {
                        const parent = currentNode.parentNode
                        const cloneParent = parent.cloneNode(false)
                        cloneParent.appendChild(currentCloneNode)
                        currentCloneNode = cloneParent
                        currentNode = parent
                    }
                    body.appendChild(currentCloneNode)
                }

                getModulesPDFContent() {
                    const modules = Array.prototype.slice.call(this.contentRoot.querySelectorAll(".module-cell a"))
                    const tasks = []
                    const generator = this
                    for (let module of modules) {
                        tasks.push(new Promise(resolve => {
                            $.get(module.href, function(data) {
                                const content = $(data).find(".pdf-content")[0]
                                if (content) {
                                    generator.remoteContentDiv.appendChild(content)
                                    generator.modulesPage.push({ page : 0, text: module.innerHTML })
                                } else {
                                    generator.unvalidatedModules.push(module.innerHTML)
                                    generator.modulesPage.push({ page : -1, text: module.innerHTML })
                                }
                                resolve()
                            })
                        }))
                    }
                    return Promise.all(tasks)
                }

                tableTopBorders(children) {
                    if (children.length === 0) return
                    let firstChild = children[0]
                    if (firstChild.classList === undefined || firstChild.nodeName !== "TR") return
                    firstChild.classList.remove("border-top-0")
                    firstChild.classList.add("border-top-1")
                    this.tableTopBorders(Array.prototype.slice.call(firstChild.children))
                }

                tableBottomBorders(children) {
                    if (children.length === 0) return
                    let lastChild = children[children.length - 1]
                    if (lastChild.classList === undefined || lastChild.nodeName !== "TR") return
                    lastChild.classList.remove("border-bottom-0")
                    lastChild.classList.add("border-bottom-1")
                    this.tableBottomBorders(Array.prototype.slice.call(lastChild.children))
                }

                splitContent() {
                    /* Extracting original planning */
                    const planning = this.contentRoot.querySelector(".modules-planning")
                    const modulesRows = planning.children

                    const generator = this
                    function newDivTable() {
                        let newDiv = generator.contentRoot.cloneNode(false)
                        let table = planning.cloneNode(false)
                        newDiv.appendChild(table)
                        generator.splitContentDiv.appendChild(newDiv)
                        generator.currentDiv = table
                    }

                    newDivTable()

                    for (let i = 0; i < modulesRows.length; i++) {
                        /* Header and body of module table should not be split on 2 pages */
                        if (i < modulesRows.length - 1) {
                            const header = modulesRows[i]
                            const body = modulesRows[i + 1]
                            this.currentDiv.appendChild(header.cloneNode(true))
                            this.currentDiv.appendChild(body.cloneNode(true))
                            if (!this.fitsInPage()) {
                                this.currentDiv.removeChild(this.currentDiv.lastChild)
                                this.currentDiv.removeChild(this.currentDiv.lastChild)
                                newDivTable()
                                this.currentDiv.appendChild(header.cloneNode(true))
                                this.currentDiv.appendChild(body.cloneNode(true))
                            }
                            i++
                        } else {
                            /* Last element is always total periods row */
                            const totalRow = modulesRows[i]
                            this.currentDiv.appendChild(totalRow.cloneNode(true))
                            if (!this.fitsInPage()) {
                                this.currentDiv.removeChild(this.currentDiv.lastChild)
                                newDivTable()
                                this.currentDiv.appendChild(totalRow.cloneNode(true))
                            }
                        }
                    }
                    this.tableTopBorders(Array.prototype.slice.call(this.splitContentDiv.children))
                    this.tableBottomBorders(Array.prototype.slice.call(this.splitContentDiv.children))
                    /* Adding caption */
                    this.currentDiv = this.currentDiv.parentNode
                    const caption = this.contentRoot.querySelector(".caption")
                    this.currentDiv.appendChild(caption.cloneNode(true))
                    if (!this.fitsInPage()) {
                        this.currentDiv.removeChild(this.currentDiv.lastChild)
                        newDivTable()
                        this.currentDiv.appendChild(caption.cloneNode(true))
                    }
                    this.nPagesPlanning = this.nPages
                    
                    /* Adding modules */
                    let moduleIndex = 0
                    const modules = this.modulesPage.filter(x => x.page !== -1)
                    const splitDiv = this.splitContentDiv
                    let currentPage = this.nPages + 1
                    for (let module of Array.prototype.slice.call(this.remoteContentDiv.children)) {
                        let modulePage = modules.at(moduleIndex)
                        modulePage.page = currentPage
                        moduleIndex++
                        this.scale = this.width / module.offsetWidth
                        this.splitContentDiv = this.contentRoot.parentNode.cloneNode(false)
                        this.addContentToBody()
                        this.currentDiv = this.splitContentDiv
                        this.contentRoot = module
                        super.splitContent()
                        for (let page of Array.prototype.slice.call(this.splitContentDiv.children)) {
                            splitDiv.appendChild(page)
                            currentPage++
                        }
                    }
                    this.splitContentDiv = splitDiv
                    console.log(this.nPages + " pages")
                }

                async addPageAnchorsToDoc() {
                    return new Promise(resolve => {
                        const planningContent = Array.prototype.slice.call(this.splitContentDiv.children, 0, this.nPagesPlanning)
                        let page = 1
                        for (let planningPage of planningContent) {
                            const moduleHeaders = getLinksRelativeCoords(planningPage).filter(link => link.moduleHeader)
                            this.doc.setPage(page)
                            for (let header of moduleHeaders) {
                                let modulePage = this.modulesPage.find(x => x.text === header.text)
                                modulePage = modulePage.page !== -1 ? modulePage.page : this.doc.internal.getNumberOfPages()
                                const x = (header.x + header.w) * this.scale + marginLeft + pageAnchorShiftX
                                const y = (header.yBot) * this.scale + marginTop + pageAnchorShiftY
                                this.doc.setFont(undefined, 'normal').setFontSize(6).textWithLink("§", x, y, {pageNumber: modulePage})
                            }
                            page++
                        }
                        resolve()
                    })
                }

                async unvalidatedModulesPage() {
                    return new Promise(resolve => {
                        this.doc.addPage()
                        const nPages = this.doc.internal.getNumberOfPages()
                        this.doc.setPage(nPages)
                        const boxWidth = this.width
                        const boxHeight = 2 * sectionBoxMargin * 2 + sectionFontSize
                        let currY = marginTop
                        this.doc.setFillColor(sectionBoxColor).rect(marginLeft, currY, boxWidth, boxHeight, "F")
                        this.doc.setFont(undefined, "bold")
                            .setFontSize(sectionFontSize).text("Liste des descriptifs de module actuellement indisponibles", marginLeft + sectionBoxMargin, currY + 6 * sectionBoxMargin)
                        this.doc.setFont(undefined, "normal")
                            .setFontSize(modulesNameFontSize)
                        currY += boxHeight + sectionSpacingY
                        for (let i = 0; i < this.unvalidatedModules.length; i++) {
                            this.doc.text(`- ${this.unvalidatedModules.at(i)}`, marginLeft, currY)
                            currY += modulesNameFontSize + interLine
                        }
                        resolve()
                    })
                }

                async generateFile() {
                    await this.getModulesPDFContent()
                    this.splitContent()
                    await this.populatePDF(1)
                    await this.unvalidatedModulesPage()
                    await this.addHeaderFooterToDoc(1, this.nPagesPlanning, "Programme de formation")
                    await this.addHeaderFooterToDoc(this.nPagesPlanning + 1, this.doc.internal.getNumberOfPages(), "Descriptif de module")
                    await this.addLinksToDoc(1)
                    await this.addPageAnchorsToDoc()
                    await this.addPageNumberToDoc()
                }
            }

            async function PDF(generatorType) {
                const doc = new jsPDF(options)
                const content = document.querySelector(".pdf-content")
                if (content) {
                    const generator = new generatorType(content, doc, ["DIV"])
                    await generator.generateFile()
                    await generator.savePDF(filename)
                } else {
                    console.warn("No content found, skipping generation")
                }
            }

            switch (type) {
                case "mode":
                    await PDF(formationBookletGenerator)
                    return
                case "module":
                    await PDF(modulePDFGenerator)
                    return
                case "unite":
                    await PDF(unitPDFGenerator)
                    return
                default:
            }
        }, [filename, type, host, localhost])
    }

    async generatePDFFromRelativePath(relativePath, type) {
        const split = relativePath.split("/")
        const dest = __dirname + path.sep + 'pdf' + path.sep + relativePath.replaceAll("/", path.sep)
        let filename = split[split.length - 1]
        switch (type) {
            case "mode":
                filename = split[split.length - 2] + "-" + filename
                break;
            default:
        }
        const [page, context] = await this.openNewPage(relativePath)
        await this.loadPage(page)
        await this.setDownloadFolder(page, dest)
        await this.generatePDF(page, filename, type)
        await new Promise(resolve => {
            setTimeout(_ => {
                this.closeContext(context)
                resolve()
            }, saveTime)
        })
    }
}

function generatePDF() {
    let [modes, modules, unites] = getPagesPath()
    setTimeout(() => {
        puppeteer.launch({ headless: "new" }).then(browser => {
            const pdfGenerator = new PDFGenerator(browser, {width: 1366, height: 768 }, maxParallelBookletGeneration, maxParallelDescriptionGeneration, maxParallelSheetGeneration)
            pdfGenerator.run(modes, modules, unites, maxParallelBookletGeneration, maxParallelDescriptionGeneration, maxParallelSheetGeneration).then(_ => {
                browser.close().then()
            })
        })
    }, devServerDelay)
}

generatePDF()