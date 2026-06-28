"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mod_Credentials = exports.mod_Users = void 0;
const se_configbase_1 = require("se_configbase");
const crypto = require('crypto');
class mod_CredentialsUPD extends se_configbase_1.mod_dataupdater {
    constructor(mscode, instancia) {
        super(mscode, instancia);
    }
    crearUpdates() {
        this.updates.push(new se_configbase_1.mod_update(1, `
        -- Tabla para permission
        CREATE TABLE permission (
            id INT AUTO_INCREMENT PRIMARY KEY,
            domainid varchar(150) NOT NULL DEFAULT '',
            description VARCHAR(255) NOT NULL,
            status ENUM('hide', 'disabled', 'enabled','default') NOT NULL DEFAULT 'default',
            type ENUM('permissive', 'restrictive') NOT NULL DEFAULT 'permissive', 
            domain varchar(50) NOT NULL DEFAULT 'global'
        );
            `));
        this.updates.push(new se_configbase_1.mod_update(2, `
        -- Tabla para accounts
        CREATE TABLE accounts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            idges int NOT NULL,
            username VARCHAR(50) NOT NULL UNIQUE,
            email VARCHAR(126) NOT NULL,
            passwordhash VARCHAR(125) NOT NULL,
            passwordges VARCHAR(125) NOT NULL
        );
            `));
        this.updates.push(new se_configbase_1.mod_update(3, `

        -- Tabla intermedia para la relación entre authorizations y permission
        CREATE TABLE authorizations (
            accountid INT NOT NULL,
            permissionid INT NOT NULL,
            PRIMARY KEY (accountid, permissionid),
            FOREIGN KEY (accountid) REFERENCES accounts(id) ON DELETE CASCADE,
            FOREIGN KEY (permissionid) REFERENCES permissions(id) ON DELETE CASCADE
        );
            `));
        this.updates.push(new se_configbase_1.mod_update(4, `

        -- Tabla para sessions
        CREATE TABLE sessions (
            token VARCHAR(150) PRIMARY KEY,
            agestoken VARCHAR(150),
            expirationtime DATETIME NOT NULL,
            accountid INT NOT NULL,
            domain VARCHAR(50) NOT NULL DEFAULT 'global',
            status ENUM('active', 'inactive','expired','unknow') NOT NULL DEFAULT 'unknow',
            devicehash VARCHAR(150),
            FOREIGN KEY (accountid) REFERENCES accounts(id) ON DELETE CASCADE
        );

        `));
    }
    obtenerConexion() {
        let oCon = new mod_Credentials();
        return oCon.obtenerConexion();
    }
}
class mod_Users extends se_configbase_1.mod_dataaccess_generico {
    constructor(mscode = undefined, instancia = undefined, database = undefined) {
        super(mscode, instancia, database);
    }
    obtenerConexion(multiple) {
        return super.obtenerConexion(multiple);
    }
    obtenerConexionado(multiple) {
        if (!this.connection) {
            this.connection = this.obtenerConexion(multiple);
        }
        return this.connection;
    }
}
exports.mod_Users = mod_Users;
class mod_Credentials extends se_configbase_1.mod_dataaccess_generico {
    // #region Funciones de inicialización  
    constructor(mscode = undefined, instancia = undefined, database = undefined) {
        super(mscode, instancia, database);
    }
    obtenerUpdates() {
        return new mod_CredentialsUPD(this.mscode, this.instancia);
    }
}
exports.mod_Credentials = mod_Credentials;
