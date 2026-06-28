import { Connection, RowDataPacket } from "mysql2";
import { mod_dataaccess, mod_dataupdater, mod_update, mod_dataaccess_generico } from "se_configbase";
import { cnt_AccountHolder, cnt_heartbeat, cnt_Permission, cnt_SessionHolder, sessionStatus } from "se_contractholder";

const crypto = require('crypto');
class mod_CredentialsUPD extends mod_dataupdater {
    constructor(mscode: string, instancia: string) {
        super(mscode, instancia);
    }
    crearUpdates() {
        this.updates.push(new mod_update(1, `
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
        this.updates.push(new mod_update(2, `
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
        this.updates.push(new mod_update(3, `

        -- Tabla intermedia para la relación entre authorizations y permission
        CREATE TABLE authorizations (
            accountid INT NOT NULL,
            permissionid INT NOT NULL,
            PRIMARY KEY (accountid, permissionid),
            FOREIGN KEY (accountid) REFERENCES accounts(id) ON DELETE CASCADE,
            FOREIGN KEY (permissionid) REFERENCES permissions(id) ON DELETE CASCADE
        );
            `));
        this.updates.push(new mod_update(4, `

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

        `
        ));
    }
    obtenerConexion(): Connection {
        let oCon = new mod_Credentials();
        return oCon.obtenerConexion();
    }
}

export class mod_Users extends mod_dataaccess_generico {
    // #region Funciones de inicialización  
        connection?: Connection | undefined;
        constructor(mscode = undefined, instancia = undefined, database = undefined) {
            super(mscode, instancia, database);
    
        }
    obtenerConexion(multiple?: boolean): Connection {
        return super.obtenerConexion(multiple);
    }
    obtenerConexionado(multiple: boolean): Connection {
        if (!this.connection) {
            this.connection = this.obtenerConexion(multiple);
        }
        return this.connection;
    }
    // #endregion
}
export class mod_Credentials extends mod_dataaccess_generico {
    // #region Funciones de inicialización  
    constructor(mscode = undefined, instancia = undefined, database = undefined) {
        super(mscode, instancia, database);

    }

    obtenerUpdates() {
        return new mod_CredentialsUPD(this.mscode, this.instancia);
    }
    // #endregion

    

    
  
}


