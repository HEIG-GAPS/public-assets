const puppeteer = require('puppeteer');
var fs = require("fs")
const path = require("path");
const Queue = require("queue-promise")
const toml = require("toml")

const localhost = "http://localhost:1313/"
const config = toml.parse(fs.readFileSync("./hugo.toml", 'utf-8'))
// const host = localhost
const host = config.baseURL

async function generatePDF(browser, pagePath, type) {
    /* Setting up page and destination folder */
    const context = await browser.createIncognitoBrowserContext()
    const page = await context.newPage()
    await page.setViewport({
        width: 640,
        height: 480
    })
    //page.on('console', msg => console.log(`Page ${pagePath} log : `, msg.text()));
    await page.goto(localhost + pagePath, {waitUntil : 'domcontentloaded'})
    const client = await page.target().createCDPSession()
    const dest = 'pdf/' + pagePath
    if (!fs.existsSync(path.join(__dirname, dest))) fs.mkdirSync(dest, {recursive: true})
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dest,
    })

    /* Loading page and generate PDF */
    const dom = await page.$eval('html', element => {
        return element.innerHTML
    })
    await page.setContent(dom)
    try {    
            await page.evaluate(async ([path, type, host]) => {
            const { jsPDF } = window.jspdf
            /* PDF generation settings */
            const savingDelay = 100 // Time to wait before assuming document is saved
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
            const hesImgPath = "/images/hes_so_logo_cmyk_monochrome-e1654175067456.png"
            const heigImgPath = "/images/HEIG-VD_logotype-baseline_rouge-rvb.png"

            /* Footer */
            const footerXSpacing = 90
            const infos = "T +41 (0)24 557 63 30\ninfo@heig-vd.ch"
            const footerFontSize = 7

            /* Header */
            const imgYmargin = 10

            /* Unvalidated modules page */
            const sectionBoxMargin = 2
            const sectionBoxColor = "#6495ed"
            const sectionFontSize = 10
            const modulesNameFontSize = 8
            const sectionSpacingY = 10

            /* Hyperlinks injection */
            const linkShiftX = 0.5
            const pageAnchorShiftX = 2

            const interLine = 3

            /* ------------------------- Utils ------------------------- */

            function getLinksRelativeCoords(content) {
                const links = content.querySelectorAll(".pdf-link")
                const contentBRect = content.getBoundingClientRect()
                var linksCoords = []
                for (let i = 0; i < links.length; i++) {
                    const link = links[i]
                    const linkBRect = link.getBoundingClientRect()
                    linksCoords.push({x: linkBRect.left -  contentBRect.left,
                                    yTop: linkBRect.top - contentBRect.top, 
                                    yBot: linkBRect.bottom - contentBRect.top,
                                    w: linkBRect.right - linkBRect.left, 
                                    h: linkBRect.bottom - linkBRect.top, 
                                    text: link.innerHTML,
                                    url: host + path,
                                    moduleHeader: (link.className).includes("module-header")
                                    })
                }
                return linksCoords
            }

            /* ------------------------- Header and footer ------------------------- */
            function addPageNumberToDoc(doc) {
                const nPages = doc.internal.getNumberOfPages()
                for (let i = 1; i <= nPages; i++) {
                    doc.setPage(i)
                    doc.setFont(undefined, "normal").text(`${i} / ${nPages}`, marginLeft, doc.internal.pageSize.getHeight() - marginBot / 2, { baseline: "bottom" })
                }
            }

            function pageFooter(doc, pageNumber, additionalContent) {
                doc.setPage(pageNumber)
                var footerY = doc.internal.pageSize.getHeight() - marginBot / 2
                doc.setFontSize(footerFontSize)
                var footerX = (doc.internal.pageSize.getWidth() - marginLeft - marginRight) / 2 - doc.getTextWidth(infos) / 2
                doc.text(infos, footerX, footerY, { baseline: "bottom" })
                const imgHeight = 50
                const imgWidth = 90
                footerX = doc.internal.pageSize.getWidth() - marginRight - imgWidth
                var hesImg = new Image()
                hesImg.src = hesImgPath
                doc.addImage(hesImg, 'png', footerX, footerY - imgHeight / 2, imgWidth, imgHeight, undefined, 'FAST')
            }

            function pageHeader(doc, pageNumber, additionalContent) {
                doc.setPage(pageNumber)
                var headerY = imgYmargin
                var headerX = marginLeft
                const imgHeight = marginTop - 2 * imgYmargin
                const imgWidth = 100
                var heigImg = new Image()
                heigImg.src = heigImgPath
                doc.addImage(heigImg, 'png', headerX, headerY, imgWidth, imgHeight)
                headerX += doc.internal.pageSize.getWidth() - marginLeft - 2 * marginRight - doc.getTextWidth(additionalContent)
                doc.setFont(undefined, "bold").text(additionalContent, headerX, headerY, { baseline: "top" })
            }

            function pageHeaderFooter(doc, pageNumber, footerContent, HeaderContent) {
                pageFooter(doc, pageNumber, footerContent)
                pageHeader(doc, pageNumber, HeaderContent)
            }

            function addHeaderFooterToDoc(doc, startPage, endPage, footerContent, HeaderContent) {
                for (let i = startPage; i <= endPage; i++) {
                    pageHeaderFooter(doc, i, footerContent, HeaderContent)
                }
            }

            /* ------------------------- PDF sections population ------------------------- */
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
                var nextY = pageY
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
                        useCORS: true,
                        scale: scale,
                        removeContainer: true,
                        onclone: (_, elem) => {
                            elem.style.setProperty("zoom", (1 / window.devicePixelRatio * 100) + "%")
                        }
                    },
                    y: (pageNumber - 1) * pageContentHeight + pageY,
                    margin: margins,
                    callback: function(doc) {
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
                        if (nPages > pageNumber){
                            for (let i = nPages; i > pageNumber; i--) {
                                doc.deletePage(i)
                            }
                        }
                        addContentsToPDF(contents.slice(1), doc, nextY, pageNumber, resolve)
                    }
                })
            }

            function generateSectionsPDF(content, selectors , doc, pageNumber) {
                /* 
                Getting content to be render by section (A section shall not 
                be split on multiple page)
                */
                sections = []
                for (let i = 0; i < selectors.length; i++) {
                    const targetContent = content.querySelector(selectors.at(i))
                    sections.push(targetContent)
                }
                return new Promise(resolve => {
                    addContentsToPDF(sections, doc, 0, pageNumber, resolve)
                })
            }

            /* ------------------------- PDF generation ------------------------- */

            function generateModulePDF(content, doc, pageNumber) {
                selectors = [
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
                    ".module-bibliographie",
                    ".module-enseignants",
                    ".card-footer"
                ]
                return generateSectionsPDF(content, selectors, doc, pageNumber)
            }

            function modulePDF(module) {
                const filename = `${module}.pdf`
                const doc = new jsPDF(options)
                return new Promise(resolve => {
                    const content = document.querySelector(".pdf-content")
                    if (content) {
                        generateModulePDF(content, doc, 1).then( _ => {
                            addHeaderFooterToDoc(doc, 1, doc.internal.getNumberOfPages(), null, "Descriptif de module")
                            addPageNumberToDoc(doc)
                            doc.save(filename, {returnPromise: true}).then(_=> {
                                setTimeout(_=> {resolve()}, savingDelay)
                            })
                        })
                    } else {
                        console.warn(`Module ${module} is not validated yet`)
                        resolve()
                    }
                    
                })
            }

            function generateUnitPDF(content, doc, pageNumber) { 
                selectors = [
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

            function unitPDF(unit) {
                const filename = `${unit}.pdf`
                const doc = new jsPDF(options)
                return new Promise(resolve => {
                    const content = document.querySelector(".pdf-content")
                    if (content) {
                        generateUnitPDF(content, doc, 1).then( _ => {
                            addHeaderFooterToDoc(doc, 1, doc.internal.getNumberOfPages(), null, "Fiche d'unité")
                            addPageNumberToDoc(doc)
                            doc.save(filename, {returnPromise: true}).then(_=> {
                                setTimeout(_=> {resolve()}, savingDelay)
                            })
                        })
                    } else {
                        console.warn(`Unit ${unit} is not validated yet`)
                        resolve()
                    }
                })
            }

            function generateModulesPlanningPDF(doc) {

                var moduleHeaders = []

                const planning = document.querySelector(".modules-planning")
                const links = getLinksRelativeCoords(planning)
                var linksIndex = 0
                const pageContentWidth = doc.internal.pageSize.getWidth() - (marginLeft + marginRight)
                const pageContentHeight = doc.internal.pageSize.getHeight() - (marginTop + marginBot)
                const modulesRows = planning.children
                let splitTableDiv = document.createElement("div")
                splitTableDiv.style = `visibility: hidden; position: fixed; right: -10000px; top: -10000px; border: 0px;`
                document.body.appendChild(splitTableDiv)
                const scale = pageContentWidth / planning.clientWidth

                var newDiv = document.createElement("div")
                splitTableDiv.appendChild(newDiv)
                var table = document.createElement("table")
                table.className = "table modules-planning"
                newDiv.appendChild(table)

                for (let i = 0; i < modulesRows.length; i++) {
                    if (i < modulesRows.length - 1) {
                        const header = modulesRows[i]
                        const body = modulesRows[i + 1]
                        const totalHeight = (header.clientHeight + body.clientHeight) * scale
                        currentHeight = splitTableDiv.lastChild.clientHeight * scale
                        if (currentHeight + totalHeight >= pageContentHeight - pageEpsilon) {
                            var newDiv = document.createElement("div")
                            splitTableDiv.appendChild(newDiv)
                            var table = document.createElement("table")
                            table.className = "table modules-planning"
                            table.style.width = `${planning.clientWidth}px`
                            newDiv.appendChild(table)
                        }
                        splitTableDiv.lastChild.firstChild.appendChild(header.cloneNode(true))
                        splitTableDiv.lastChild.firstChild.appendChild(body.cloneNode(true))
                        i++
                    } else {
                        const totalRow = modulesRows[i]
                        const height = totalRow.clientHeight * scale
                        currentHeight = splitTableDiv.lastChild.clientHeight * scale
                        if (currentHeight + height >= pageContentHeight - pageEpsilon) {
                            var newDiv = document.createElement("div")
                            splitTableDiv.appendChild(newDiv)
                            var table = document.createElement("table")
                            table.className = "table modules-planning"
                            table.style.width = `${planning.clientWidth}px`
                            newDiv.appendChild(table)
                        }
                        splitTableDiv.lastChild.firstChild.appendChild(totalRow.cloneNode(true))
                    }
                }
                const caption = document.querySelector(".caption")
                const captionHeight = caption.clientHeight * scale
                currentHeight = splitTableDiv.lastChild.clientHeight * scale
                if (currentHeight + captionHeight >= pageContentHeight - pageEpsilon) {
                    var newDiv = document.createElement("div")
                    splitTableDiv.appendChild(newDiv)
                }
                splitTableDiv.lastChild.appendChild(caption)
                
                function addPages(pages, pageNumber, resolve) {
                    if (pages.length < 1) {
                        resolve(moduleHeaders)
                        return
                    }
                    const page = pages.at(0)
                    doc.addPage()
                    doc.html(page, {
                        html2canvas: {
                            allowTaint: true,
                            useCORS: true,
                            scale: scale,
                            removeContainer: true,
                            onclone: (_, elem) => {
                                elem.style.setProperty("zoom", (1 / window.devicePixelRatio * 100) + "%")
                            }
                        },
                        y: (pageNumber - 1) * pageContentHeight,
                        margin: margins,
                        callback: function(doc) {
                            /* Adding links */
                            const nLinks = page.querySelectorAll(".pdf-link").length
                            for (let i = 0; i < nLinks; i++) {
                                const link = links[i + linksIndex]
                                const linkX = marginLeft + link.x * scale + linkShiftX
                                var linkY = marginTop + (link.yBot - links[linksIndex].yBot + link.h) * scale
                                doc.link(linkX, linkY, link.w * scale, link.h * scale, {url: link.url})
                                if (link.moduleHeader) {
                                    moduleHeaders.push({ x: linkX, y : linkY, w : link.w * scale, text: link.text, page : pageNumber })
                                }
                            }
                            /* Clearing unwanted blankpages */
                            const nPages = doc.internal.getNumberOfPages()
                            if (nPages > pageNumber) {
                                for (let i = nPages; i > pageNumber; i--) {
                                    doc.deletePage(i)
                                }
                            }
                            /* Adding header and footer to new page */
                            pageHeaderFooter(doc, pageNumber, null, "Programme de formation")
                            linksIndex += nLinks
                            addPages(pages.slice(1), ++pageNumber, resolve)
                        }
                    })
                }
                return new Promise(resolve => {
                    addPages(Array.prototype.slice.call(splitTableDiv.children), 1, resolve)
                })
            }

            function generateFormationBooklet(formation) {

                const filename = `${formation}.pdf`
                const doc = new jsPDF(options)
                var unvalidatedModules = []
                var modulesPage = []

                const modules = Array.prototype.slice.call(document.querySelectorAll(".module-cell a"))

                /* Adding a new div to document body to allow rendering of html from modules pages */
                let remoteContentDiv = document.createElement("div")
                remoteContentDiv.style = "visibility: hidden; position: fixed; left: -10000px; top: -10000px; border: 0px;"
                document.body.appendChild(remoteContentDiv)
                return new Promise(resolvePDF => {
                    generateModulesPlanningPDF(doc).then(modulesCoords => {
                        new Promise(resolveModules => {
                            function addModulesToPDF(modules, resolve) {
                                if (modules.length < 1) {
                                    resolve("Added modules to PDF")
                                    return
                                }
                                $.get(modules.at(0).href, function(data) {
                                    const moduleName = modules.at(0).innerHTML
                                    content = $(data).find(".pdf-content")[0]
                                    if (content) {
                                        remoteContentDiv.appendChild(content)
                                        doc.addPage()
                                        const startPage = doc.internal.getNumberOfPages()
                                        modulesPage.push({name: moduleName, page: startPage})
                                        generateModulePDF(content, doc, startPage).then(_ => { 
                                            addHeaderFooterToDoc(doc, startPage, doc.internal.getNumberOfPages(), null, "Descriptif de module")
                                            remoteContentDiv.removeChild(content)
                                            addModulesToPDF(modules.slice(1), resolve)
                                        })
                                    } else {
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
                                const boxWidth = doc.internal.pageSize.getWidth() - (marginLeft + marginTop)
                                const boxHeight = 2 * sectionBoxMargin * 2 + sectionFontSize
                                var currY = marginTop
                                doc.setFillColor(sectionBoxColor).rect(marginLeft, currY, boxWidth, boxHeight, "F")
                                doc.setFontSize(sectionFontSize)
                                .setFont(undefined, "bold")
                                .text("Liste des descriptifs de module actuellement indisponibles", marginLeft + sectionBoxMargin, currY + 6 * sectionBoxMargin)
                                currY += boxHeight + sectionSpacingY
                                doc.setFontSize(modulesNameFontSize).setFont(undefined, "normal")
                                for (let i = 0; i < unvalidatedModules.length; i++) {
                                    doc.text(`- ${unvalidatedModules.at(i)}`, marginLeft, currY)
                                    currY += modulesNameFontSize + interLine
                                }
                                const nPages = doc.internal.getNumberOfPages()
                                addHeaderFooterToDoc(doc, nPages, nPages, null, "Descriptif de module")
        
                                /* Adding modules description pages to modules planning */
                                for (let i = 0; i < modulesPage.length; i++) {
                                    const mod = modulesPage[i]
                                    var page = mod.page
                                    if (page === -1) {
                                        page = nPages
                                    }
                                    const coords = modulesCoords.filter(m => m.text.includes(mod.name)).at(0)
                                    doc.setPage(coords.page)
                                    doc.textWithLink("§", coords.x + coords.w + pageAnchorShiftX, coords.y + 2, {pageNumber: page})
                                }
                            }
                            addPageNumberToDoc(doc)
                            doc.save(filename, {returnPromise: true}).then(_=> {
                                setTimeout(() => resolvePDF(), savingDelay)
                            })
                        })
                    })
                })
            }
            const split = path.split('/')
            switch(type) {
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
        }, [pagePath, type, host])
    } finally {
        return context
    }
}

const modes = []
const modules = []
const unites = []
const topFolder = "public"

function listModulesUnits(folderPaths, depth) {
    folderPaths.forEach( folderPath => {
        const results = fs.readdirSync(folderPath)
        const folders = results.filter(res => fs.lstatSync(path.resolve(folderPath, res)).isDirectory())
        const innerFolderPaths = folders.map(folder => path.resolve(folderPath, folder))
        if (depth === 1) modules.push(path.relative(topFolder, folderPath))
        if (depth === 2) unites.push(path.relative(topFolder, folderPath))
        if (innerFolderPaths.length === 0) return
        listModulesUnits(innerFolderPaths, depth + 1)
    })
}

function listFolders(folderPaths) {
    folderPaths.forEach( folderPath => {
        const results = fs.readdirSync(folderPath)
        const folders = results.filter(res => fs.lstatSync(path.resolve(folderPath, res)).isDirectory())
        const innerFolderPaths = folders.map(folder => path.resolve(folderPath, folder))
        if (!(folderPath.endsWith("/pt") || folderPath.endsWith("/tp-ee"))) listFolders(innerFolderPaths)
        else {
            modes.push(path.relative(topFolder, folderPath))
            listModulesUnits(innerFolderPaths, 1)
        }
        if (innerFolderPaths.length === 0) return
    })
}

function padTo2Digits(num) {
    return num.toString().padStart(2, '0');
}

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

const maxParallelBookletGeneration = 2
const maxParallelDescriptionGeneration = 5
const maxParallelSheetGeneration = 5

const browserClosingDelay = 1000
const devServerDelay = 5000

function run() {
    listFolders([path.resolve(__dirname, topFolder)], 0)
    setTimeout(() => {
            puppeteer.launch({ headless: "new" }).then(browser=> {
            const start = performance.now()
            const queueBooklets = new Queue({
                concurrent: maxParallelBookletGeneration,
                interval : 20
            })
            queueBooklets.enqueue(modes.map(x => {
                return async () => {
                    const context = await generatePDF(browser, x, "mode")
                    context.close()
                }
            }))
            queueBooklets.on("end", () => {
                const moduleStart = performance.now()
                console.info("Generated formation booklets in ", msToHMS(moduleStart - start))
                const queueDescriptions = new Queue({
                    concurrent: maxParallelDescriptionGeneration,
                    interval : 20
                })
                queueDescriptions.enqueue(modules.map(x => {
                    return async () => {
                        const context = await generatePDF(browser, x, "module")
                        context.close()
                    }
                }))
                queueDescriptions.on("end", () => {
                    const unitStart = performance.now()
                    console.info("Generated module descriptions in ", msToHMS(unitStart - moduleStart))
                    const queueSheets = new Queue({
                        concurrent: maxParallelSheetGeneration,
                        interval : 20
                    })
                    queueSheets.enqueue(unites.map(x => {
                        return async () => {
                            const context = await generatePDF(browser, x, "unite")
                            context.close()
                        }
                    }))
                    queueSheets.on("end", () => {
                        const end = performance.now()
                        console.info("Generated unit sheets in ", msToHMS(end -unitStart))
                        setTimeout(() => {
                            console.info("Closing browser...")
                            console.info("Generated PDF files in ", msToHMS(end - start))
                            browser.close()
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

run()