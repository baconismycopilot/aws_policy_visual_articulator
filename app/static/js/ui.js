"use strict";

const serviceList = document.querySelector(".service");
const resetButton = document.querySelector("#reset");
const prefixDiv = document.querySelector("#action-prefix");
const detailsDiv = document.querySelector(".arn-details-table-container");
const actionsDiv = document.querySelector(".actions-table-container");

/**
 *
 * @param {string} serviceId
 * @returns {Promise<any>}
 */
async function fetchService(serviceId) {
    const url = "/service/" + serviceId;
    try {
        const response = await fetch(url);
        if (response.ok) {
            return await response.json();
        }
    } catch (error) {
        console.error(error);
        throw new Error(`Response status: ${error.status}`);
    }
}

/**
 *
 * @param {string} prefix
 * @returns {HTMLDivElement}
 */
function checkboxWithLabel(prefix) {
    const newDiv = document.createElement("div")
    const checkbox = document.createElement("input");
    const label = document.createElement("label");

    newDiv.setAttribute("class", "form-check form-check-inline");
    checkbox.setAttribute("class", "form-check-input p-2");
    checkbox.setAttribute("type", "checkbox");
    checkbox.setAttribute("name", "prefix");
    checkbox.setAttribute("value", prefix);
    checkbox.setAttribute("id", prefix);

    label.setAttribute("class", "form-check-label p-1");
    label.setAttribute("for", prefix);
    label.textContent = prefix;
    label.append(checkbox);
    newDiv.appendChild(label);

    return newDiv
}


function newTable() {
    const t = document.createElement("table");
    t.setAttribute("class", "table table-dark table-bordered table-hover");

    return t;
}

/**
 * Make a thead element with given text.
 * @param {Array} textArray
 * @returns {HTMLTableSectionElement}
 */
function newThead(textArray) {
    const thead = document.createElement("thead");
    const row = document.createElement("tr");

    thead.setAttribute("class", "table-dark")

    textArray.forEach(headerText => {
        const ht = document.createTextNode(headerText);
        const th = document.createElement("th");
        th.appendChild(ht);
        row.appendChild(th);
    })

    thead.appendChild(row);

    return thead;
}

/**
 *
 * @param {Array}textContents
 * @returns {HTMLTableRowElement}
 */
function newTableRow(textContents) {
    const row = document.createElement("tr");

    textContents.forEach(text => {
        const textNode = document.createTextNode(text);
        const data = document.createElement("td")
        data.appendChild(textNode);
        row.appendChild(data);
    })

    return row;
}

/**
 * Draws ARN Details.
 * @param {object} arnDetails
 */
function drawArnDetailsTable(arnDetails) {
    const arnTable = newTable();
    const tbody = document.createElement("tbody");

    arnTable.setAttribute("class", "table table-bordered table-hover");
    arnTable.appendChild(newThead(["ARN Format", "ARN Regex", "ARN Condition Keys", "String Prefix"]));
    tbody.appendChild(
        newTableRow([
            arnDetails.arn_format || "NA",
            arnDetails.arn_regex || "NA",
            arnDetails.arn_condition_keys || "NA",
            arnDetails.string_prefix || "NA"
        ]));

    arnTable.appendChild(tbody);
    detailsDiv.replaceChildren(arnTable);

    console.log(arnDetails);
}

/**
 * Draws ARN Details.
 * @construtor
 * @param {Array} actionPrefixes
 * @param {object} actions
 */
function drawActionDetails(actionPrefixes, actions) {
    const actionsTable = newTable();
    actionsTable.setAttribute("class", "table table-hover");
    const tbody = document.createElement("tbody");

    actionsTable.appendChild(newThead(["Privilege", "Access Level", "Description"]));

    actionPrefixes.forEach((prefix) => {
        const checkbox = checkboxWithLabel(prefix);
        prefixDiv.appendChild(checkbox);

        checkbox.addEventListener("change", (event) => {
            console.log(event);

            if (event.target.checked) {
                // actionsTable.parentElement.appendChild(thead);

                actions.privileges.forEach(action => {
                    if (action.privilege.startsWith(prefix)) {
                        console.log(action);
                        const rowData = newTableRow([action.privilege, action.access_level, action.description])
                        tbody.appendChild(rowData);
                    }
                })
                actionsTable.appendChild(tbody);
                actionsDiv.appendChild(actionsTable)
            }

            if (!event.target.checked) {
                const prefix = event.target.value
                const tableRows = actionsTable.querySelectorAll("tr");

                tableRows.forEach(row => {
                    if (row.innerText.startsWith(prefix)) {
                        row.remove()
                        return false;
                    }
                })
            }
        });
    })
}

resetButton.addEventListener("click", () => {
    reset();
})

serviceList.addEventListener("change", (event) => {
    const serviceData = fetchService(event.target.value);

    detailsDiv.replaceChildren();
    prefixDiv.replaceChildren();
    actionsDiv.replaceChildren();

    serviceData.then((response) => {
        drawArnDetailsTable(response);
        drawActionDetails(response.action_prefixes, response.actions)
    });
})

/**
 * Resets selections.
 */
function reset() {
    serviceList.selectedIndex = 0;
    prefixDiv.replaceChildren();
    detailsDiv.replaceChildren();
    actionsDiv.replaceChildren();
}