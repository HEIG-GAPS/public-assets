const puppeteer = require('puppeteer');
const fs = require("fs")
const path = require("path");
const Queue = require("queue-promise")
const toml = require("toml")

const localhost = "http://localhost:1313/"
const config = toml.parse(fs.readFileSync("./hugo.toml", 'utf-8'))
const host = config.baseURL

/**
 * Generates a PDF using jsPDF through a Puppeteer headless browser
 * @param {puppeteer.Browser} browser - Puppeteer Browser
 * @param {string} pagePath - relative path of the page from which the script will generate the PDF
 * @param {string} type - type of PDF to generate, one of ["mode", "module", "unite"]. If any other value is used, no PDF will be generated.
 * @returns {puppeteer.BrowserContext} The context created and used to generate the PDF. Used to be closed later.
 */
async function generatePDF(browser, pagePath, type) {

    /* Creating new BrowserContext and opening page */
    const context = await browser.createIncognitoBrowserContext()
    const page = await context.newPage()
    page.on('console', msg => console.log('PAGE ' + pagePath + ': ', msg.text()))
    /* Navigate to page */
    await page.goto(localhost + pagePath, {waitUntil: 'domcontentloaded'})
    await page.setViewport({width: 1920, height: 1080})

    /* Setting up destination folder */
    const client = await page.target().createCDPSession()
    const dest = 'pdf/' + pagePath
    if (!fs.existsSync(path.join(__dirname, dest))) fs.mkdirSync(dest, {recursive: true})
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dest,
    })

    /* Loading page */
    const dom = await page.$eval('html', element => {
        return element.innerHTML
    })
    await page.setContent(dom)

    /* Generate PDF */
    try {
        await page.evaluate(async ([path, type, host, localhost]) => {

            const {jsPDF} = window.jspdf

            /* PDF generation settings */
            const savingDelay = 1500 // Time to wait in ms before assuming document is saved
            const imgWriteDelay = 5 // Time to wait in ms before assuming image is written in PDF

            /* PDF layout */
            const marginTop = 60
            const marginBot = 30
            const marginLeft = 20
            const marginRight = marginLeft
            const pageEpsilon = 2 // Epsilon to calculate left space on page when displaying sections in pdf
            const margins = [marginTop, marginRight, marginBot, marginLeft]
            const options = {
                orientation: "p",
                unit: "px",
                format: "a4",
                margin: margins,
                compress: true
            }

            /* Image sources */
            const hesImgPath = "/images/logo_hesso_bw.svg"
            const heigImgPath = "/images/logo-heig-21-fr.svg"

            /* Footer */
            const infos = "T +41 (0)24 557 63 30\ninfo@heig-vd.ch"
            const footerFontSize = 7

            /* Header */
            const imgYmargin = 10
            const hesImgLoaded = loadSVG(hesImgPath, 4)
            const heigImgLoaded = loadSVG(heigImgPath, 5)

            /* Unvalidated modules page */
            const sectionBoxMargin = 2
            const sectionBoxColor = "#0762FD"
            const sectionFontSize = 10
            const modulesNameFontSize = 8
            const sectionSpacingY = 10

            /* Hyperlinks injection */
            const linkShiftX = 0.5
            let linkShiftY = - 1;
            const pageAnchorShiftX = 2

            /* Other settings */
            const interLine = 3
            const remoteContentDivWidth = 1200 // Width unit is px

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

            /* ------------------------- Header and footer ------------------------- */
            /**
             * Adds the page number to every page footer
             * @param {jsPDF} doc - jsPDF document to write in
             */
            function addPageNumberToDoc(doc) {
                return new Promise(resolve => {
                    const nPages = doc.internal.getNumberOfPages()
                    for (let i = 1; i <= nPages; i++) {
                        doc.setPage(i)
                        doc.setFont(undefined, "normal").text(`${i} / ${nPages}`, marginLeft, doc.internal.pageSize.getHeight() - marginBot / 2, {baseline: "bottom"})
                    }
                    resolve("Added page number to PDF")
                })
            }

            /**
             * Adds footer the document specified page.
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageNumber - The number of the page where the footer should be added
             */
            function pageFooter(doc, pageNumber) {
                const footerY = doc.internal.pageSize.getHeight() - marginBot / 2
                let footerX = (doc.internal.pageSize.getWidth() - marginLeft - marginRight) / 2 - doc.getTextWidth(infos) / 2
                doc.setPage(pageNumber).setFont(undefined, "normal").setFontSize(footerFontSize).text(infos, footerX, footerY, {baseline: "bottom"})
                return new Promise(resolve => {
                    hesImgLoaded.then(([imgDataURL, width, height]) => {
                        const imgHeight = marginBot - 2 * imgYmargin
                        const imgWidth = width * imgHeight / height
                        footerX = doc.internal.pageSize.getWidth() - marginRight - imgWidth
                        doc.setPage(pageNumber).addImage(imgDataURL, "PNG", footerX, footerY - imgHeight / 2, imgWidth, imgHeight, undefined, 'FAST')
                        setTimeout(() => {
                            resolve("Added footer to PDF on page " + pageNumber)
                        }, imgWriteDelay)
                    })
                })
            }

            /**
             * Adds header the document specified page.
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageNumber - The number of the page where the header should be added
             * @param {string} headerTitle - The title of the header
             */
            function pageHeader(doc, pageNumber, headerTitle) {
                const headerY = imgYmargin
                let headerX = marginLeft
                return new Promise(resolve => {
                        heigImgLoaded.then(([imgDataURL, width, height]) => {
                            const imgHeight = marginTop - 2 * imgYmargin
                            const imgWidth = width * imgHeight / height
                            doc.setPage(pageNumber).addImage(imgDataURL, "PNG", headerX, headerY, imgWidth, imgHeight, undefined, 'FAST')
                            headerX += doc.internal.pageSize.getWidth() - marginLeft - 2 * marginRight - doc.getTextWidth(headerTitle)
                            doc.setPage(pageNumber).setFont(undefined, "bold").text(headerTitle, headerX, headerY, {baseline: "top"})
                            setTimeout(() => {
                                resolve("Added header to PDF on page " + pageNumber)
                            }, imgWriteDelay)
                        })
                    }
                )
            }

            /**
             * Adds header and footer the document specified page.
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageNumber - The number of the page where the header and footer should be added
             * @param {string} headerTitle - The title of the header
             */
            function pageHeaderFooter(doc, pageNumber, headerTitle) {
                return new Promise(resolve => {
                    const tasks = [pageFooter(doc, pageNumber), pageHeader(doc, pageNumber, headerTitle)]
                    Promise.all(tasks).then(_ => {
                        resolve("Added header and footer to PDF on page " + pageNumber)
                    })
                })
            }

            /**
             * Adds header and footer the document specified range of pages.
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {*} startPage - First page on which header and footer should be added
             * @param {*} endPage - Last page on which header and footer should be added
             * @param {*} headerTitle - The title of the header
             */
            function addHeaderFooterToDoc(doc, startPage, endPage, headerTitle) {
                let tasks = []
                for (let i = startPage; i <= endPage; i++) {
                    tasks.push(pageHeaderFooter(doc, i, headerTitle))
                }
                return new Promise(resolve => {
                    Promise.all(tasks).then(_ => {
                        resolve("Added header and footer to PDF on pages " + startPage + " to " + endPage)
                    })
                })
            }

            /* ------------------------- PDF sections population ------------------------- */
            /**
             * Adds all contents to PDF document on a specified page and position. Each piece of
             * content shall not be split on multiple pages.
             * One shall verifiy that each content can fit in one page.
             * @param {Element[]} contents - All contents to be added to the PDF.
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageY - The Y cords where to start the Rendering
             * @param {Number} pageNumber - The page on which the content shall be placed
             * @param {Promise<any>} resolve - A promise to resolve when all the contents is added to the PDF document.
             */
            function addContentsToPDF(contents, doc, pageY, pageNumber, resolve) {
                if (contents.length < 1) {
                    resolve("Added all sections to PDF")
                    return
                }
                const content = contents.at(0)
                const contentHeight = content.clientHeight
                const pageContentWidth = doc.internal.pageSize.getWidth() - (marginLeft + marginRight)
                const pageContentHeight = doc.internal.pageSize.getHeight() - (marginTop + marginBot)
                const scale = pageContentWidth / content.clientWidth
                let nextY = pageY
                if (contentHeight * scale >= pageContentHeight - pageEpsilon) {
                    const splitContentDiv = document.createElement("div")
                    splitContentDiv.style = `visibility: hidden; position: fixed; right: -10000px; top: -10000px; border: 0px; width: ${remoteContentDivWidth}px`
                    document.body.appendChild(splitContentDiv)
                    let newDiv = document.createElement("div")
                    splitContentDiv.appendChild(newDiv)
                    newDiv.className = content.className
                    const children = content.children
                    const header = children[0]
                    const body = children[1]
                    const bodyParts = body.children[0].children
                    const bodyLastPart = body.children[1]
                    newDiv.appendChild(header.cloneNode(true))
                    let newBody = document.createElement("div")
                    newBody.className = body.className
                    newDiv.appendChild(newBody)
                    for (let i = 0; i < bodyParts.length; i++) {
                        newDiv = document.createElement("div")
                        splitContentDiv.appendChild(newDiv)
                        newDiv.className = content.className
                        newBody = document.createElement("div")
                        newBody.className = body.className
                        newDiv.appendChild(newBody)
                        newBody.appendChild(bodyParts[i].cloneNode(true))
                    }
                    newDiv = document.createElement("div")
                    splitContentDiv.appendChild(newDiv)
                    newDiv.className = content.className
                    newBody = document.createElement("div")
                    newBody.className = body.className
                    newDiv.appendChild(newBody)
                    newBody.appendChild(bodyLastPart.cloneNode(true))
                    addContentsToPDF(Array.prototype.slice.call(splitContentDiv.children).concat(contents.slice(1)), doc, pageY, pageNumber, resolve)
                }
                if (pageY + contentHeight * scale >= pageContentHeight - pageEpsilon) {
                    doc.addPage()
                    pageNumber++
                    pageY = 0
                    nextY = contentHeight * scale
                } else {
                    nextY = pageY + contentHeight * scale
                }
                doc.html(content, {
                    html2canvas: {
                        allowTaint: true,
                        logging: false,
                        useCORS: true,
                        scale: scale,
                        removeContainer: true,
                        width: content.clientWidth,
                        height: content.clientHeight,
                        windowWidth: pageContentWidth
                    },
                    y: (pageNumber - 1) * pageContentHeight + pageY,
                    margin: margins,
                    callback: function (doc) {
                        /* Adding hyperlinks */
                        const links = getLinksRelativeCoords(content)
                        for (let i = 0; i < links.length; i++) {
                            const link = links[i]
                            const linkX = marginLeft + link.x * scale
                            const linkY = marginTop + pageY + link.yTop * scale
                            doc.link(linkX + linkShiftX, linkY, link.w * scale, link.h * scale, {url: link.url})
                        }
                        /* Clearing unwanted blankpages */
                        const nPages = doc.internal.getNumberOfPages()
                        if (nPages > pageNumber) {
                            for (let i = nPages; i > pageNumber; i--) {
                                doc.deletePage(i)
                            }
                        }
                        addContentsToPDF(contents.slice(1), doc, nextY, pageNumber, resolve)
                    }
                })
            }

            /**
             * Add content to PDF. Content is first split down in sections using the selectors
             * argument and then added to the PDF using the addContentsToPDF function.
             * The selectors are used to prevent pieces of content to be split on multiples pages.
             * @param {Element} content - The content to be added to PDF
             * @param {string[]} selectors - Selectors to split down content in different sections.
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageNumber - The first page on which the content should be rendered
             * @returns {Promise<any>} a promise resolved when all sections are added to PDF
             */
            function generateSectionsPDF(content, selectors, doc, pageNumber) {
                /*
                Getting content to be render by section (A section shall not
                be split on multiple page)
                */
                let sections = []
                for (let i = 0; i < selectors.length; i++) {
                    const targetContent = content.querySelector(selectors.at(i))
                    sections.push(targetContent)
                }
                return new Promise(resolve => {
                    addContentsToPDF(sections, doc, 0, pageNumber, resolve)
                })
            }

            /* ------------------------- PDF generation ------------------------- */

            /**
             * Generates the PDF of a module in document starting at specified page
             * @param {Element} content - The content to add to PDF
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageNumber - The first page on which module should be added
             * @returns {Promise<any>} a promise resolved when module is added to PDF
             */
            function generateModulePDF(content, doc, pageNumber) {
                let selectors = [
                    ".module-titre",
                    ".module-titre-infos",
                    ".module-intitule",
                    ".module-organisation",
                    ".module-prerequis",
                    ".module-objectifs",
                    ".module-enseignements",
                    ".module-evaluation",
                    ".module-remediation",
                    ".module-remarques",
                    ".module-bibliographie"
                ]
                return generateSectionsPDF(content, selectors, doc, pageNumber)
            }

            /**
             * Creates and saves PDF file of module description
             * @param {string} module - Name of the module
             * @returns {Promise<any>} A promise resolved when file is saved
             */
            function modulePDF(module) {
                const filename = `${module}.pdf`
                const doc = new jsPDF(options)
                return new Promise(resolve => {
                    const content = document.querySelector(".pdf-content")
                    if (content) {
                        generateModulePDF(content, doc, 1).then(_ => {
                            const tasks = [addHeaderFooterToDoc(doc, 1, doc.internal.getNumberOfPages(), "Descriptif de module"),
                            addPageNumberToDoc(doc)]
                            Promise.all(tasks).then(_ => {
                                doc.save(filename, {returnPromise: true}).then(_ => {
                                    setTimeout(_ => {
                                        resolve()
                                    }, savingDelay)
                                })
                            })
                        })
                    } else {
                        console.warn(`Module ${module} is not validated yet`)
                        resolve()
                    }

                })
            }

            /**
             * Generates the PDF of a unit in document starting at specified page
             * @param {Element} content - The content to add to PDF
             * @param {jsPDF} doc - jsPDF document to write in
             * @param {Number} pageNumber - The first page on which unit should be added
             * @returns {Promise<any>} a promise resolved when unit is added to PDF
             */
            function generateUnitPDF(content, doc, pageNumber) {
                let selectors = [
                    ".unit-title",
                    ".unit-general-infos",
                    ".unit-periods",
                    ".unit-periods-table",
                    ".unit-objectives",
                    ".unit-prior-knowledge",
                    ".unit-content",
                    ".unit-bibliography",
                    ".unit-controls"
                ]
                return generateSectionsPDF(content, selectors, doc, pageNumber)
            }

            /**
             * Creates and saves PDF file of unit sheet
             * @param {string} unit - Name of the unit
             * @returns {Promise<any>} A promise resolved when file is saved
             */
            function unitPDF(unit) {
                const filename = `${unit}.pdf`
                const doc = new jsPDF(options)
                return new Promise(resolve => {
                    const content = document.querySelector(".pdf-content")
                    if (content) {
                        generateUnitPDF(content, doc, 1).then(_ => {
                            const tasks = [addHeaderFooterToDoc(doc, 1, doc.internal.getNumberOfPages(), "Fiche d'unité"),
                            addPageNumberToDoc(doc)]
                            Promise.all(tasks).then(_ => {
                                doc.save(filename, {returnPromise: true}).then(_ => {
                                    setTimeout(_ => {
                                        resolve()
                                    }, savingDelay)
                                })
                            })
                        })
                    } else {
                        console.warn(`Unit ${unit} is not validated yet`)
                        resolve()
                    }
                })
            }

            /**
             * Generates modules planning and adds it to PDF document.
             * @param {jsPDF} doc - jsPDF document to write in
             * @returns {Promise<Object[]>} A promise resolving with a list of
             * every module link (filtered list of links) in the planning. Used
             * later to add page anchors to PDF and last page of PDF (unvalidated modules).
             */
            function generateModulesPlanningPDF(doc) {


                /* Extracting original planning */
                const planning = document.querySelector(".modules-planning")
                const modulesRows = planning.children

                /* Getting all links */
                const links = getLinksRelativeCoords(planning)
                let moduleHeaders = []
                let linksIndex = 0

                /* Adding each subtable of planning to offside div, allowing html2canvas to render it */
                let splitTableDiv = document.createElement("div")
                splitTableDiv.style = `visibility: hidden; position: fixed; right: -10000px; top: -10000px; border: 0px;`
                document.body.appendChild(splitTableDiv)
                let newDiv = document.createElement("div")
                splitTableDiv.appendChild(newDiv)
                let table = document.createElement("table")
                table.className = "table modules-planning"
                table.style.width = `${planning.clientWidth}px`
                newDiv.appendChild(table)

                /* Doc constants */
                const pageContentWidth = doc.internal.pageSize.getWidth() - (marginLeft + marginRight)
                const pageContentHeight = doc.internal.pageSize.getHeight() - (marginTop + marginBot)
                const scale = pageContentWidth / planning.clientWidth

                function newDivTable() {
                    newDiv = document.createElement("div")
                    splitTableDiv.appendChild(newDiv)
                    table = document.createElement("table")
                    table.className = "table modules-planning"
                    table.style.width = `${planning.clientWidth}px;`
                    newDiv.appendChild(table)
                }

                for (let i = 0; i < modulesRows.length; i++) {
                    /* Header and body of module table should not be split on 2 pages */
                    if (i < modulesRows.length - 1) {
                        const header = modulesRows[i]
                        const body = modulesRows[i + 1]
                        const totalHeight = (header.clientHeight + body.clientHeight) * scale
                        let currentHeight = splitTableDiv.lastChild.clientHeight * scale
                        if (currentHeight + totalHeight >= pageContentHeight - pageEpsilon) {
                            newDivTable()
                        }
                        splitTableDiv.lastChild.firstChild.appendChild(header.cloneNode(true))
                        splitTableDiv.lastChild.firstChild.appendChild(body.cloneNode(true))
                        i++
                    } else {
                        /* Last element is always total periods row */
                        const totalRow = modulesRows[i]
                        const height = totalRow.clientHeight * scale
                        let currentHeight = splitTableDiv.lastChild.clientHeight * scale
                        if (currentHeight + height >= pageContentHeight - pageEpsilon) {
                            newDivTable()
                        }
                        splitTableDiv.lastChild.firstChild.appendChild(totalRow.cloneNode(true))
                    }
                }
                /* Rendering caption at last */
                const caption = document.querySelector(".caption")
                const captionHeight = caption.clientHeight * scale
                let currentHeight = splitTableDiv.lastChild.clientHeight * scale
                if (currentHeight + captionHeight >= pageContentHeight - pageEpsilon) {
                    newDiv = document.createElement("div")
                    splitTableDiv.appendChild(newDiv)
                }
                splitTableDiv.lastChild.appendChild(caption)

                /**
                 *
                 * @param {Element[]} pages - All the pages to add to PDF
                 * @param {Number} pageNumber - First page on which pages should be added
                 * @param {Promise<any>} resolve - A promise to be resolved when all pages are added
                 */
                function addPages(pages, pageNumber, resolve) {
                    if (pages.length < 1) {
                        const nPages = doc.internal.getNumberOfPages()
                        addHeaderFooterToDoc(doc, 1, nPages, "Programme de formation")
                        resolve(moduleHeaders)
                        return
                    }
                    const page = pages.at(0)
                    doc.addPage()
                    doc.html(page, {
                        html2canvas: {
                            allowTaint: true,
                            useCORS: true,
                            logging: false,
                            scale: scale,
                            removeContainer: true
                        },
                        y: (pageNumber - 1) * pageContentHeight,
                        margin: margins,
                        callback: function (doc) {
                            /* Adding links */
                            const nLinks = page.querySelectorAll(".pdf-link").length
                            for (let i = 0; i < nLinks; i++) {
                                const link = links[i + linksIndex]
                                const linkX = marginLeft + link.x * scale + linkShiftX
                                const linkY = marginTop + (link.yBot - links[linksIndex].yBot + link.h) * scale + linkShiftY
                                doc.link(linkX, linkY, link.w * scale, link.h * scale, {url: link.url})
                                if (link.moduleHeader) {
                                    moduleHeaders.push({
                                        x: linkX,
                                        y: linkY,
                                        w: link.w * scale,
                                        text: link.text,
                                        page: pageNumber
                                    })
                                }
                            }
                            /* Clearing unwanted blankpages */
                            const nPages = doc.internal.getNumberOfPages()
                            if (nPages > pageNumber) {
                                for (let i = nPages; i > pageNumber; i--) {
                                    doc.deletePage(i)
                                }
                            }
                            linksIndex += nLinks
                            addPages(pages.slice(1), ++pageNumber, resolve)
                        }
                    })
                }

                return new Promise(resolve => {
                    addPages(Array.prototype.slice.call(splitTableDiv.children), 1, resolve)
                })
            }

            /**
             * Creates and saves formation booklet as PDF
             * @param {string} formation - Name of the formation
             */
            function generateFormationBooklet(formation) {

                const filename = `${formation}.pdf`
                const doc = new jsPDF(options)

                let unvalidatedModules = []
                let modulesPage = []
                let startPage = 1

                const modules = Array.prototype.slice.call(document.querySelectorAll(".module-cell a"))

                /* Adding a new div to document body to allow rendering of html from modules pages */
                let remoteContentDiv = document.createElement("div")
                remoteContentDiv.style = `visibility: hidden; position: fixed; left: -10000px; top: -10000px; border: 0px; width: ${remoteContentDivWidth}px`
                document.body.appendChild(remoteContentDiv)
                return new Promise(resolvePDF => {
                    /* Adding planning first */
                    generateModulesPlanningPDF(doc).then(modulesCoords => {
                        startPage = doc.internal.getNumberOfPages() + 1
                        new Promise(resolveModules => {
                            /**
                             *
                             * @param {Element[]} modules - All modules contained in formation programm.
                             * Elements must have a href atrtibute from which module content shall be
                             * retrieved using JQuery.
                             * @param {Promise<any>} resolve - A promise to be resolved when all modules
                             * content are added to PDF
                             */
                            function addModulesToPDF(modules, resolve) {
                                if (modules.length < 1) {
                                    resolve("Added modules to PDF")
                                    return
                                }
                                /* Getting module content from link */
                                $.get(modules.at(0).href, function (data) {
                                    /* Extracting content */
                                    const moduleName = modules.at(0).innerHTML
                                    const content = $(data).find(".pdf-content")[0]
                                    /* Validated module */
                                    if (content) {
                                        remoteContentDiv.appendChild(content)
                                        content.style.width = `${content.clientWidth}px`
                                        doc.addPage()
                                        const startPage = doc.internal.getNumberOfPages()
                                        modulesPage.push({name: moduleName, page: startPage})
                                        generateModulePDF(content, doc, startPage).then(_ => {
                                            remoteContentDiv.removeChild(content)
                                            addModulesToPDF(modules.slice(1), resolve)
                                        })
                                    } else /* Module not yet validated or error occured */ {
                                        unvalidatedModules.push(modules.at(0).innerText)
                                        addModulesToPDF(modules.slice(1), resolve)
                                        modulesPage.push({name: moduleName, page: -1})
                                    }
                                })
                            }
                            addModulesToPDF(modules, resolveModules)
                        }).then(_ => {
                            document.body.removeChild(remoteContentDiv)
                            if (unvalidatedModules.length > 0) {
                                doc.addPage()
                                /* This section does not render must wait before writing */
                                const nPages = doc.internal.getNumberOfPages()
                                const boxWidth = doc.internal.pageSize.getWidth() - (marginLeft + marginRight)
                                const boxHeight = 2 * sectionBoxMargin * 2 + sectionFontSize
                                let currY = marginTop
                                doc.setFillColor(sectionBoxColor).rect(marginLeft, currY, boxWidth, boxHeight, "F")
                                doc.setFont(undefined, "bold")
                                   .setFontSize(sectionFontSize).text("Liste des descriptifs de module actuellement indisponibles", marginLeft + sectionBoxMargin, currY + 6 * sectionBoxMargin)
                                doc.setFont(undefined, "normal")
                                   .setFontSize(modulesNameFontSize)
                                currY += boxHeight + sectionSpacingY
                                for (let i = 0; i < unvalidatedModules.length; i++) {
                                    doc.text(`- ${unvalidatedModules.at(i)}`, marginLeft, currY)
                                    currY += modulesNameFontSize + interLine
                                }
                                /* Adding modules description pages to modules planning */
                                for (let i = 0; i < modulesPage.length; i++) {
                                    const mod = modulesPage[i]
                                    let page = mod.page
                                    if (page === -1) {
                                        page = nPages
                                    }
                                    const coords = modulesCoords.filter(m => m.text.includes(mod.name)).at(0)
                                    doc.setPage(coords.page)
                                    doc.textWithLink("§", coords.x + coords.w + pageAnchorShiftX, coords.y + 3.5, {pageNumber: page})
                                }
                            }
                            addHeaderFooterToDoc(doc, startPage, doc.internal.getNumberOfPages(), "Descriptif de module").then(_ => {
                                addPageNumberToDoc(doc).then(_ => {
                                    setTimeout(_ => {
                                        doc.save(filename, {returnPromise: true}).then(_ => {
                                            setTimeout(_ => {
                                                resolvePDF()
                                            }, savingDelay)
                                        })
                                    }, savingDelay)
                                })
                            })
                        })
                    })
                })
            }
            const split = path.split('/')
            switch (type) {
                case "mode":
                    await generateFormationBooklet(split[split.length - 2] + "-" + split[split.length - 1])
                    return
                case "module":
                    await modulePDF(split[split.length - 1])
                    return
                case "unite":
                    await unitPDF(split[split.length - 1])
                    return
                default:
            }
        }, [pagePath, type, host, localhost])
        return context
    } catch (err) {
        console.info(err)
        return context
    }
}

const modes = []
const modules = []
const unites = []
const topFolder = "public"

/**
 * Retrieves the list of modules and units from every specified paths.
 * This script writes in the global variables modules and unites
 * @param {string[]} folderPaths - Source Paths
 * @param {Number} depth - The current depth from source paths. Assuming that 1
 * indicates the function is at modules level and 2 units level.
 */
function listModulesUnits(folderPaths, depth) {
    folderPaths.forEach(folderPath => {
        const results = fs.readdirSync(folderPath)
        const folders = results.filter(res => fs.lstatSync(path.resolve(folderPath, res)).isDirectory())
        const innerFolderPaths = folders.map(folder => path.resolve(folderPath, folder))
        if (depth === 1) modules.push(path.relative(topFolder, folderPath))
        if (depth === 2) unites.push(path.relative(topFolder, folderPath))
        if (innerFolderPaths.length === 0) return
        listModulesUnits(innerFolderPaths, depth + 1)
    })
}

/**
 * Retrieves the list of formation programms, modules and units from every specified paths
 * This script writes in the global variables modes, modules and unites
 * @param {string[]} folderPaths - Source Paths
 */
function listFolders(folderPaths) {
    folderPaths.forEach(folderPath => {
        const results = fs.readdirSync(folderPath)
        const folders = results.filter(res => fs.lstatSync(path.resolve(folderPath, res)).isDirectory())
        const innerFolderPaths = folders.map(folder => path.resolve(folderPath, folder))
        if (innerFolderPaths.length === 0) return
        if (!(folderPath.endsWith("/pt") || folderPath.endsWith("/tp-ee"))) listFolders(innerFolderPaths)
        else {
            modes.push(path.relative(topFolder, folderPath))
            listModulesUnits(innerFolderPaths, 1)
        }
    })
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
 * @returns {string} formated time range string
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
const maxParallelBookletGeneration = 3
const maxParallelDescriptionGeneration = 6
const maxParallelSheetGeneration = 7

/* Delays to wait fo asychronous tasks (Img writing, saving documents, opening/closing browser contexts) */
const browserClosingDelay = 1000
const saveTime = 500
const devServerDelay = 5000

/**
 * Generates all the PDF from the site using Puppeteer. Every page path is obtained from
 * the public folder (containing hugo site pages). The PDF are generated in parallel using Queue-promise
 * library.
 */
function run() {
    listFolders([path.resolve(__dirname, topFolder)], 0)
    setTimeout(() => {
        puppeteer.launch({headless: "new" }).then(browser => {
            const start = performance.now()
            const queueBooklets = new Queue({
                concurrent: maxParallelBookletGeneration,
                interval: 0
            })
            queueBooklets.enqueue(modes.map(x => {
                return async () => {
                    const context = await generatePDF(browser, x, "mode")
                    await context.close()
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
                        const context = await generatePDF(browser, x, "module")
                        await context.close()
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
                    queueSheets.enqueue(unites.map(x => {
                        return async () => {
                            const context = await generatePDF(browser, x, "unite")
                            await context.close()
                        }
                    }))
                    queueSheets.on("reject", (err) => {
                        console.info(err)
                    })
                    queueSheets.on("end", () => {
                        const end = performance.now()
                        console.info("Generated unit sheets in ", msToHMS(end - unitStart))
                        setTimeout(() => {
                            console.info("Closing browser...")
                            console.info("Generated PDF files in ", msToHMS(end - start))
                            browser.close().then()
                        }, browserClosingDelay)
                    })
                    queueSheets.start()
                })
                queueDescriptions.start()
            })
            queueBooklets.start()
        })
    }, devServerDelay)
}

class PDFGenerator {
    constructor(browser, viewport) {
        this.browser = browser
        this.viewport = viewport
    }

    async openNewContext() {
        return await this.browser.createIncognitoBrowserContext()
    }

    async closeContext(context) {
        return await context.close()
    }

    async openNewPage(url) {
        const context = await this.openNewContext()
        const page = await context.newPage()
        page.on('console', msg => console.log(url + ': ', msg.text()))
        await page.goto(url)
        await page.setViewport(this.viewport)
        return [page, context]
    }

    async setDownloadFolder(page, folder) {
        const client = await page.target().createCDPSession()
        if (!fs.existsSync(path.join(__dirname, folder))) fs.mkdirSync(folder, {recursive: true})
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: folder,
        })
    }

    async loadPage(page) {
        const dom = await page.$eval('html', element => {
            return element.innerHTML
        })
        await page.setContent(dom)
    }

    async generatePDF(page, filename, type) {
        await page.evaluate(async ([filename, type, host, localhost]) => {

            const {jsPDF} = window.jspdf

            /* PDF generation settings */
            const savingDelay = 1700 // Time to wait in ms before assuming document is saved
            const imgWriteDelay = 5 // Time to wait in ms before assuming image is written in PDF

            /* PDF layout */
            const marginTop = 60
            const marginBot = 30
            const marginLeft = 20
            const marginRight = marginLeft
            const pageEpsilon = 50 // Epsilon to calculate left space on page when displaying sections in pdf
            const margins = [marginTop, marginRight, marginBot, marginLeft]
            const options = {
                orientation: "p",
                unit: "px",
                format: "a4",
                margin: margins,
                compress: true
            }

            /* Image sources */
            const hesImgPath = "/images/logo_hesso_bw.svg"
            const heigImgPath = "/images/logo-heig-21-fr.svg"

            /* Footer */
            const infos = "T +41 (0)24 557 63 30\ninfo@heig-vd.ch"
            const footerFontSize = 7

            /* Header */
            const imgYmargin = 10
            const hesImgLoaded = loadSVG(hesImgPath, 4)
            const heigImgLoaded = loadSVG(heigImgPath, 5)

            /* Unvalidated modules page */
            const sectionBoxMargin = 2
            const sectionBoxColor = "#0762FD"
            const sectionFontSize = 10
            const modulesNameFontSize = 8
            const sectionSpacingY = 10

            /* Hyperlinks injection */
            const linkShiftX = 0.5
            let linkShiftY = - 1;
            const pageAnchorShiftX = 2

            /* Other settings */
            const interLine = 3
            const remoteContentDivWidth = 1200 // Width unit is px

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
            class ContentSplitter {
                constructor(contentRoot, width, height) {
                    this.contentRoot = contentRoot
                    this.width = width
                    this.height = height
                    this.scale = width / contentRoot.clientWidth
                    this.currentHeight = 0
                    this.splitContentDiv = this.contentRoot.parentNode.cloneNode(false)
                    this.bindContentToBody()
                    this.currentDiv = this.splitContentDiv
                    this.nPages = 1
                }

                bindContentToBody() {
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
                    currentCloneNode.style.visibility = "hidden"
                    currentCloneNode.style.position = "fixed"
                    currentCloneNode.style.left = "-10000px"
                    body.appendChild(currentCloneNode)
                    console.log(document.body)
                }

                fitsInPage(content) {
                    return this.currentHeight + content.clientHeight * this.scale < this.height
                }

                splitContent() {
                    this._splitContent(this.contentRoot)
                }

                _splitContent(content) {
                    if (content.getAttribute("data-html2canvas-ignore") !== null) return
                    if (this.fitsInPage(content)) { // Adding node and its children
                        console.info("Content fits in page")
                        this.currentDiv.appendChild(content.cloneNode(true))
                        this.currentHeight += content.clientHeight * this.scale
                    } else {
                        console.info("Content has to be split")
                        this.currentDiv.appendChild(content.cloneNode(false))
                        this.currentDiv = this.currentDiv.lastChild
                        const children = Array.prototype.slice.call(content.children)
                        const childrenElements = children.filter(child => child.nodeName === "DIV")
                        if (childrenElements.length !== children.length) console.warn("Content contains non element children")
                        if (childrenElements.length > 0) { // Node
                            console.info("Content can be split")
                            for (let i = 0; i < childrenElements.length; i++) {
                                this._splitContent(childrenElements[i])
                            }
                            this.currentDiv = this.currentDiv.parentNode
                        } else { // Leaf
                            console.info("Content cannot be split, adding new page")
                            this.currentHeight = 0
                            this.nPages++
                            if (!this.fitsInPage(content)) {
                                console.warn("Unsplittable content is too big for one page")
                                return
                            }
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
                        }
                    }
                }
            }

            class PDFGenerator extends ContentSplitter {
                constructor(content, doc) {
                    super(content,
                          doc.internal.pageSize.getWidth() - (marginLeft + marginRight),
                          doc.internal.pageSize.getHeight() - (marginTop + marginBot));
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
                            this.doc.setFont(undefined, "normal").text(`${i} / ${nPages}`, marginLeft, this.doc.internal.pageSize.getHeight() - marginBot / 2, {baseline: "bottom"})
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
                    let footerX = (this.doc.internal.pageSize.getWidth() - marginLeft - marginRight) / 2 - this.doc.getTextWidth(infos) / 2
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

                addLinksToContent(content) {
                    const links = getLinksRelativeCoords(content)
                    for (let i = 0; i < links.length; i++) {
                        const link = links[i]
                        const linkX = marginLeft + link.x * this.scale
                        const linkY = marginTop + link.yTop * this.scale
                        this.doc.link(linkX + linkShiftX, linkY, link.w * this.scale, link.h * this.scale, {url: link.url})
                    }
                }

                clearOverflowingPages(wantedPages) {
                    const nPages = this.doc.internal.getNumberOfPages()
                    if (nPages > wantedPages) {
                        for (let i = nPages; i > wantedPages; i--) {
                            this.doc.deletePage(i)
                        }
                    }
                }

                addPagesCallback(content, pageNumber) {
                    this.addLinksToContent(content)
                    this.clearOverflowingPages(pageNumber)
                }

                addPages(pages, pageNumber) {
                    const generator = this
                    function _addPages(pages, pageNumber, resolve) {
                        if (pages.length < 1) {
                            resolve()
                            return
                        }
                        const page = pages.at(0)
                        generator.doc.addPage()
                        generator.doc.html(page, {
                            html2canvas: {
                                allowTaint: true,
                                useCORS: true,
                                logging: false,
                                scale: generator.scale,
                                removeContainer: true
                            },
                            y: (pageNumber - 1) * generator.height,
                            margin: margins,
                            callback: function (_) {
                                generator.addPagesCallback(page, pageNumber)
                                _addPages(pages.slice(1), ++pageNumber, resolve)
                            }
                        })
                    }
                    return new Promise(resolve => {
                        _addPages(pages, pageNumber, resolve)
                    })
                }

                async generatePDF(pageNumber) {
                    this.splitContent()
                    await this.addPages(Array.prototype.slice.call(this.splitContentDiv.children), pageNumber)
                    await this.addHeaderFooterToDoc(pageNumber, this.doc.internal.getNumberOfPages(), "Descriptif de module")
                    await this.addPageNumberToDoc()

                }

                async savePDF(filename) {
                    console.info("Saving PDF")
                    await this.doc.save(filename, {returnPromise: true})
                }
            }
            switch (type) {
                case "mode":
                    return
                case "module":
                    //await modulePDF(filename)
                    const doc = new jsPDF(options)
                    const generator =
                        new PDFGenerator(document.querySelector(".pdf-content"),
                                         doc,
                                         "Descriptif de module")
                    await generator.generatePDF(1)
                    await generator.savePDF(filename)
                    console.log("Saved PDF")
                    return
                case "unite":
                    return
                default:
            }
        }, [filename, type, host, localhost])
    }

    async generatePDFFromURL(url, dest, filename, type) {
        const [page, context] = await this.openNewPage(url)
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

function test() {
    puppeteer.launch({ headless: false }).then(browser => {
        const pdfGenerator = new PDFGenerator(browser, {width: 1920, height: 1080})
        pdfGenerator.generatePDFFromURL(localhost + "bachelor/economie-et-services/heg/ee/ee/pt/comm/", "test", "test.pdf", "module").then(_ => {
            browser.close().then()
        })
    })
}

test()
